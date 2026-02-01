const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const axios = require("axios");

dotenv.config();

const app = express();

// ==============================
// 0) Middleware (Smartwebi-proof)
// ==============================
app.use(cors());
app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "*/json", "*/*"],
  }),
);
app.use(express.urlencoded({ extended: true }));

// ==============================
// 1) Load CSV ONCE
// ==============================
let PDF_TABLE = [];

function loadPdfTableOnce() {
  const csv = fs.readFileSync("./grade1.csv", "utf8");
  const records = parse(csv, { columns: true, skip_empty_lines: true });

  PDF_TABLE = records.map((r) => ({
    keyword: (r.keyword || "").trim().toLowerCase(),
    pdf_name: (r.pdf_name || "").trim(),
    pdf_link: (r.pdf_link || "").trim(),
  }));

  console.log(`✅ Loaded ${PDF_TABLE.length} PDFs from grade1.csv`);
}

function findPdfByKeyword(keyword) {
  const key = (keyword || "").trim().toLowerCase();
  return PDF_TABLE.find((x) => x.keyword === key) || null;
}

loadPdfTableOnce();

// Optional: reload CSV without restarting
app.get("/reload", (req, res) => {
  try {
    loadPdfTableOnce();
    res.json({ ok: true, count: PDF_TABLE.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ==============================
// 2) Brevo send function
// ==============================
async function sendEmailViaBrevo({ toEmail, toName, subject, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderName = process.env.BREVO_SENDER_NAME;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;

  if (!apiKey) throw new Error("BREVO_API_KEY missing");
  if (!senderName || !senderEmail)
    throw new Error("BREVO_SENDER_NAME or BREVO_SENDER_EMAIL missing");

  // Brevo Transactional API endpoint
  const url = "https://api.brevo.com/v3/smtp/email";

  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: toEmail, name: toName }],
    subject,
    textContent: text,
  };

  const resp = await axios.post(url, payload, {
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    timeout: 15000,
  });

  return resp.data; // contains messageId etc.
}

// ==============================
// 3) MCP discovery endpoint
// ==============================
app.get("/mcp", (req, res) => {
  res.json({
    name: "teacher-pdf-mcp",
    version: "1.0.0",
    tools: [
      {
        name: "send_pdf_by_keyword",
        description: "Find PDF by keyword and email it to the teacher.",
        inputSchema: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            teacher_name: { type: "string" },
            teacher_email: { type: "string" },
          },
          required: ["keyword", "teacher_name", "teacher_email"],
        },
      },
    ],
  });
});

// ==============================
// 4) ONE tool endpoint (reads Smartwebi customData)
// ==============================
app.post("/mcp/tools/send_pdf_by_keyword", async (req, res) => {
  try {
    console.log("----- INCOMING REQUEST -----");
    console.log("HEADERS:", req.headers);
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    // Smartwebi sends your fields inside customData
    const data =
      req.body?.customData ||
      req.body?.input ||
      req.body?.arguments ||
      req.body?.payload ||
      req.body ||
      {};

    const keyword = data.keyword || data.requested_pdf;
    const teacher_name =
      data.teacher_name || data.name || req.body?.full_name || "Teacher";
    const teacher_email = data.teacher_email || data.email || req.body?.email;

    if (!keyword || !teacher_email) {
      return res.status(400).json({
        ok: false,
        message:
          "Missing required fields. Need keyword + teacher_email (and teacher_name recommended).",
        received_keys: Object.keys(data),
      });
    }

    const found = findPdfByKeyword(keyword);
    if (!found) {
      return res.status(404).json({
        ok: false,
        message: "No PDF found for that keyword",
        keyword,
      });
    }

    const subject = `Requested PDF: ${found.pdf_name}`;
    const text =
      `Hi ${teacher_name},\n\n` +
      `Here is your requested document:\n\n` +
      `${found.pdf_name}\n${found.pdf_link}\n\n` +
      `— ESC 17`;

    const brevoResp = await sendEmailViaBrevo({
      toEmail: teacher_email,
      toName: teacher_name,
      subject,
      text,
    });

    return res.json({
      ok: true,
      message: "PDF request processed",
      keyword,
      pdf_name: found.pdf_name,
      brevo: brevoResp, // contains messageId, etc.
    });
  } catch (err) {
    // show Brevo error details if available
    const detail =
      err?.response?.data || err?.message || "Server error while sending email";
    console.log("❌ ERROR:", detail);

    return res.status(500).json({
      ok: false,
      message: typeof detail === "string" ? detail : JSON.stringify(detail),
    });
  }
});

app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 5050}`);
});
