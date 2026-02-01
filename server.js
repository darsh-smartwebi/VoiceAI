const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const nodemailer = require("nodemailer");
const { z } = require("zod");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

// (Optional) reload CSV without restarting server
app.get("/reload", (req, res) => {
  try {
    loadPdfTableOnce();
    res.json({ ok: true, count: PDF_TABLE.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ==============================
// 2) Email transporter
// ==============================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Optional: verify SMTP at startup (helps debug)
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
// 4) ONE tool endpoint (no chaining)
// ==============================
app.post("/mcp/tools/send_pdf_by_keyword", async (req, res) => {
  try {
    const schema = z.object({
      keyword: z.string().min(1),
      teacher_name: z.string().min(1),
      teacher_email: z.string().email(),
    });

    const { keyword, teacher_name, teacher_email } = schema.parse(req.body);

    // 1) Find PDF from CSV
    const found = findPdfByKeyword(keyword);

    if (!found) {
      return res.status(404).json({
        ok: false,
        message: "No PDF found for that keyword",
        keyword,
      });
    }

    // 2) Send email with link
    const subject = `Requested PDF: ${found.pdf_name}`;
    const text =
      `Hi ${teacher_name},\n\n` +
      `Here is your requested document:\n\n` +
      `${found.pdf_name}\n${found.pdf_link}\n\n` +
      `— ESC 17`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: teacher_email,
      subject,
      text,
    });

    // 3) Return response (your Voice AI can decide wording)
    return res.json({
      ok: true,
      message: "PDF request processed",
      keyword,
      pdf_name: found.pdf_name,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      message: err?.message || "Bad Request",
    });
  }
});

// ==============================
app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 MCP server running on port ${process.env.PORT || 5050}`);
});
