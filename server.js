// server.js — BACKEND
// This is the ONLY file that talks to external APIs and holds secret keys.
// The frontend never touches these APIs directly — it only talks to this server.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Handles image uploads — files are temporarily saved to the "uploads/" folder
const upload = multer({ dest: 'uploads/' });

// Health check — visit this URL to confirm the backend is alive
app.get('/', (req, res) => {
  res.json({ status: 'Backend is running', time: new Date().toISOString() });
});

// -----------------------------------------------------------------------
// MAIN PIPELINE ENDPOINT
// Frontend sends EITHER { text: "..." } as JSON, OR a photo as multipart/form-data
// under the field name "photo", plus a "targetLanguage" field (e.g. "hi" for Hindi).
// -----------------------------------------------------------------------
app.post('/process-lesson', upload.single('photo'), async (req, res) => {
  try {
    const targetLanguage = req.body.targetLanguage || 'hi'; // default: Hindi
    let englishText = req.body.text;

    // STEP 1: OCR — only runs if a photo was uploaded instead of typed text
    if (req.file) {
      console.log('Step 1: Running OCR on uploaded image...');
      englishText = await runOCR(req.file.path);
      fs.unlink(req.file.path, () => {}); // clean up the temp file
    }

    if (!englishText || englishText.trim().length === 0) {
      return res.status(400).json({ error: 'No text found. Please provide text or a clearer photo.' });
    }

    console.log('Original text:', englishText);

    // STEP 2: Simplify the text using Claude
    const simplifiedText = await simplifyText(englishText);
    console.log('Simplified:', simplifiedText);

    // STEP 3: Translate the simplified text
    const translatedText = await translateText(simplifiedText, targetLanguage);
    console.log('Translated:', translatedText);

    // STEP 4: Generate audio narration
    const audioBase64 = await generateAudio(translatedText, targetLanguage);
    console.log('Audio generated:', audioBase64 ? 'success' : 'skipped');

    res.json({
      original: englishText,
      simplified: simplifiedText,
      translated: translatedText,
      audioBase64: audioBase64, // frontend turns this into a playable audio element
      targetLanguage: targetLanguage,
    });

  } catch (error) {
    console.error('Pipeline error:', error);
    res.status(500).json({ error: 'Something went wrong processing the lesson.' });
  }
});

// =========================================================================
// STEP FUNCTIONS — each one calls a real external API.
// Each has a safe fallback if the relevant API key isn't set yet, so your
// team can keep building the frontend/backend connection before all keys
// arrive.
// =========================================================================

// ---- OCR: reads text out of an uploaded image using Tesseract.js ----
// Tesseract.js needs NO API key — it runs locally. Good default for hackathons.
async function runOCR(imagePath) {
  const result = await Tesseract.recognize(imagePath, 'eng');
  return result.data.text;
}

// ---- SIMPLIFY: rewrites text at a grade 1-5 reading level using Claude ----
async function simplifyText(text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — returning original text unsimplified.');
    return text;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Check docs.anthropic.com/en/docs/about-claude/models for the current
      // recommended model name before your event — model names get updated.
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Rewrite the following text so a 7-9 year old (grade 2-3 reading level) can easily understand it. Use short sentences and simple words. Only return the rewritten text, nothing else.\n\nText: "${text}"`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text.trim();
  }
  console.warn('Claude API did not return expected format:', data);
  return text; // fallback to original if something went wrong
}

// ---- TRANSLATE: converts text into the target Indian language ----
// Using Google Cloud Translate here since its API is simple and stable.
// Swap this for Bhashini's /pipeline + /compute endpoints if your team
// wants the govt-backed Indian-language-specific engine — check
// bhashini.gov.in/ulca docs for the exact current request schema.
async function translateText(text, targetLanguage) {
  if (!process.env.GOOGLE_TRANSLATE_API_KEY) {
    console.warn('GOOGLE_TRANSLATE_API_KEY not set — returning original text untranslated.');
    return `[untranslated] ${text}`;
  }

  const url = `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_TRANSLATE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      target: targetLanguage, // e.g. 'hi' for Hindi, 'pa' for Punjabi, 'ta' for Tamil
      source: 'en',
      format: 'text',
    }),
  });

  const data = await response.json();
  if (data.data && data.data.translations && data.data.translations[0]) {
    return data.data.translations[0].translatedText;
  }
  console.warn('Translate API did not return expected format:', data);
  return `[translation failed] ${text}`;
}

// ---- TTS: converts translated text into spoken audio ----
async function generateAudio(text, targetLanguage) {
  if (!process.env.GOOGLE_TTS_API_KEY) {
    console.warn('GOOGLE_TTS_API_KEY not set — skipping audio generation.');
    return null;
  }

  // Google TTS language codes need a region, e.g. "hi-IN" not just "hi"
  const languageCodeMap = {
    hi: 'hi-IN',
    pa: 'pa-IN',
    ta: 'ta-IN',
    te: 'te-IN',
    mr: 'mr-IN',
    bn: 'bn-IN',
  };
  const languageCode = languageCodeMap[targetLanguage] || 'hi-IN';

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: text },
      voice: { languageCode: languageCode, ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  const data = await response.json();
  if (data.audioContent) {
    return data.audioContent; // base64-encoded MP3 — frontend converts this to a playable audio source
  }
  console.warn('TTS API did not return expected format:', data);
  return null;
}

// Start the server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
