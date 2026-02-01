const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");

dotenv.config();

const app = express();

// ==============================
// 0) Middleware (Smartwebi-proof)
// ==============================
app.use(cors());

// Accept JSON even if client sends wrong/missing content-type
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "*/json", "*/*"],
  }),
);
app.use(express.urlencoded({ extended: true }));

// ==============================
// 1) Load CSV ONCE (fast)
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
// 2) Email transporter (465/587 safe)
// ==============================
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = smtpPort === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },

  // prevent hanging forever
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,

  // force STARTTLS on 587
  ...(smtpSecure ? {} : { requireTLS: true }),
});

// verify SMTP at startup
transporter.verify((err) => {
  if (err) {
    console.log("❌ SMTP verify failed:", err.message);
  } else {
    console.log("✅ SMTP is ready");
  }
});

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
// 4) ONE tool endpoint (Smartwebi-proof payload parsing)
// ==============================
app.post("/mcp/tools/send_pdf_by_keyword", async (req, res) => {
  try {
    // Debug logs (check Render logs)
    console.log("----- INCOMING REQUEST -----");
    console.log("HEADERS:", req.headers);
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    // Unwrap common MCP / webhook formats
    const data =
      req.body?.input ||
      req.body?.arguments ||
      req.body?.payload ||
      req.body ||
      {};

    // Accept multiple possible field names
    const keyword = data.keyword || data.requested_pdf;
    const teacher_name = data.teacher_name || data.name;
    const teacher_email = data.teacher_email || data.email;

    // Validate (manual, clear errors)
    if (!keyword || !teacher_name || !teacher_email) {
      return res.status(400).json({
        ok: false,
        message:
          "Missing required fields: keyword, teacher_name, teacher_email (or requested_pdf, name, email)",
        received_keys: Object.keys(data),
        received_body: req.body,
      });
    }

    // Find PDF
    const found = findPdfByKeyword(keyword);
    if (!found) {
      return res.status(404).json({
        ok: false,
        message: "No PDF found for that keyword",
        keyword,
      });
    }

    // Email text
    const subject = `Requested PDF: ${found.pdf_name}`;
    const text =
      `Hi ${teacher_name},\n\n` +
      `Here is your requested document:\n\n` +
      `${found.pdf_name}\n${found.pdf_link}\n\n` +
      `— ESC 17`;

    // Send email
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: teacher_email,
      subject,
      text,
    });

    // Response
    return res.json({
      ok: true,
      message: "PDF request processed",
      keyword,
      pdf_name: found.pdf_name,
    });
  } catch (err) {
    console.log("❌ ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

// ==============================
app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 MCP server running on port ${process.env.PORT || 5050}`);
});
