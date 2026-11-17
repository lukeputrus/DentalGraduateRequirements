const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { UPLOADS_DIR } = require('./messages');

// A student's own coursework. The extension list is deliberately short:
// papers, worksheets and notes, not clinical photographs.
const DOCUMENT_EXTENSIONS = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const DOCUMENT_KINDS = ['Competency coursework', 'Rotation goals', 'Self-assessment', 'Advising', 'Other'];

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

function documentExtension(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return DOCUMENT_EXTENSIONS[ext] ? ext : null;
}

function saveDocument({ studentId, competencyId, kind, file }) {
  const ext = documentExtension(file.originalname);
  const storedName = `doc-${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.buffer);
  db.prepare(
    `INSERT INTO documents (student_id, competency_id, kind, original_name, stored_name, mime, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(studentId, competencyId || null, kind, file.originalname.slice(0, 200), storedName, DOCUMENT_EXTENSIONS[ext], file.size);
}

function listDocuments(studentId) {
  return db
    .prepare(
      `SELECT d.*, c.title AS competency_title
       FROM documents d LEFT JOIN competencies c ON c.id = d.competency_id
       WHERE d.student_id = ? ORDER BY d.created_at DESC, d.id DESC`
    )
    .all(studentId);
}

function deleteDocument(doc) {
  const filePath = path.join(UPLOADS_DIR, doc.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
}

// Always served as a download, never rendered inline.
function sendDocument(res, doc) {
  const filePath = path.join(UPLOADS_DIR, doc.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_KINDS,
  MAX_DOCUMENT_BYTES,
  documentExtension,
  saveDocument,
  listDocuments,
  deleteDocument,
  sendDocument,
  formatSize,
};
