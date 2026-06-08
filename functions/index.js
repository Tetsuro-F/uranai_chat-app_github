/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// force redeploy

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenAI } = require("@google/genai");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const MODEL_NAMES = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
];
const RETRY_DELAYS_MS = [600, 1400];

function getAllowedOrigins() {
    return (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function setCorsHeaders(req, res) {
    const requestOrigin = req.get("Origin");
    const allowedOrigins = getAllowedOrigins();

    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "POST");

    if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
        if (requestOrigin) {
            res.set("Access-Control-Allow-Origin", requestOrigin);
        }
        return true;
    }

    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseGeminiError(error) {
    const rawMessage = error.message || String(error);

    try {
        const parsed = JSON.parse(rawMessage);
        return {
            code: parsed.error?.code,
            status: parsed.error?.status,
            message: parsed.error?.message || rawMessage,
            rawMessage,
        };
    } catch (_) {
        return {
            code: error.code || error.status,
            status: error.status,
            message: rawMessage,
            rawMessage,
        };
    }
}

function isRetryableGeminiError(errorInfo) {
    return errorInfo.code === 503 ||
        errorInfo.code === 504 ||
        errorInfo.status === "UNAVAILABLE" ||
        errorInfo.status === "DEADLINE_EXCEEDED";
}

async function generateWithFallback(ai, userMessage) {
    let lastErrorInfo = null;

    for (const modelName of MODEL_NAMES) {
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                console.log(`Using Gemini API model: ${modelName}, attempt: ${attempt + 1}`);

                const result = await ai.models.generateContent({
                    model: modelName,
                    contents: userMessage,
                    config: {
                        temperature: 0.8,
                    },
                });

                return {
                    text: result.text,
                    modelName,
                    attempt: attempt + 1,
                };
            } catch (error) {
                const errorInfo = parseGeminiError(error);
                lastErrorInfo = { ...errorInfo, modelName, attempt: attempt + 1 };
                console.error("Gemini API attempt failed:", lastErrorInfo);

                if (!isRetryableGeminiError(errorInfo)) {
                    throw Object.assign(error, { geminiErrorInfo: lastErrorInfo });
                }

                if (attempt < RETRY_DELAYS_MS.length) {
                    await sleep(RETRY_DELAYS_MS[attempt]);
                }
            }
        }
    }

    const error = new Error(lastErrorInfo?.message || "Gemini API is temporarily unavailable.");
    error.geminiErrorInfo = lastErrorInfo;
    throw error;
}

exports.askGeminiV2 = onRequest(
    { secrets: [GEMINI_API_KEY] },
    async (req, res) => {
        const isAllowedOrigin = setCorsHeaders(req, res);

        if (req.method === "OPTIONS") {
            return res.status(isAllowedOrigin ? 204 : 403).send("");
        }

        if (!isAllowedOrigin) {
            return res.status(403).send("Origin not allowed");
        }

        if (req.method !== "POST") {
            return res.status(405).send("POST only");
        }

        try {
            const userMessage = req.body.message;
            if (typeof userMessage !== "string" || !userMessage.trim()) {
                return res.status(400).json({ error: "message が必要です" });
            }

            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });
            const result = await generateWithFallback(ai, userMessage.trim());

            const text = result.text;
            if (!text) {
                console.error("Gemini response did not include text:", result);
                return res.status(502).json({ error: "Gemini から返答テキストを取得できませんでした" });
            }

            return res.json({
                reply: text,
                model: result.modelName,
                attempt: result.attempt,
            });

        } catch (error) {
            const errorInfo = error.geminiErrorInfo || parseGeminiError(error);
            console.error("Gemini API Error:", error);
            const isTemporary = isRetryableGeminiError(errorInfo);

            return res.status(isTemporary ? 503 : 500).json({
                error: "Gemini API エラー",
                message: isTemporary
                    ? "Gemini が一時的に混み合っています。少し時間をおいてもう一度お試しください。"
                    : errorInfo.message,
                upstream: errorInfo,
            });
        }
    }
);
