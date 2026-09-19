const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function getThread(studentId) {
  return db.prepare('SELECT * FROM messages WHERE student_id = ? ORDER BY id').all(studentId);
}

// Strips server-internal fields (the on-disk storage filename, mime type)
// before a message goes into a JSON response — the client only ever needs
// enough to render the thread and link to the download route by id.
function toClientJson(message) {
  return {
    id: message.id,
    sender: message.sender,
    body: message.body,
    attachment_name: message.attachment_name,
    created_at: message.created_at,
  };
}

function getUnreadForAdmin() {
  return db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sender = 'student' AND read_at IS NULL").get().c;
}

function getUnreadForStudent(studentId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE student_id = ? AND sender = 'admin' AND read_at IS NULL")
    .get(studentId).c;
}

function markReadForAdmin(studentId) {
  db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE student_id = ? AND sender = 'student' AND read_at IS NULL"
  ).run(studentId);
}

function markReadForStudent(studentId) {
  db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE student_id = ? AND sender = 'admin' AND read_at IS NULL"
  ).run(studentId);
}

// Persists an uploaded file (from multer memoryStorage) under a
// server-generated name — never derived from user input — and returns the
// columns to store alongside the message. Returns null if no file given.
function saveAttachment(file) {
  if (!file) return null;
  const ext = ALLOWED_MIME_TYPES[file.mimetype];
  const storedName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.buffer);
  return { attachment_name: file.originalname, attachment_path: storedName, attachment_mime: file.mimetype };
}

function sendAttachment(res, message) {
  if (!message.attachment_path) return res.status(404).end();
  const filePath = path.join(UPLOADS_DIR, message.attachment_path);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', message.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${message.attachment_name.replace(/[^\x20-\x7e]/g, '_')}"`);
  res.sendFile(filePath);
}

function insertMessage({ studentId, sender, body, file }) {
  const attachment = saveAttachment(file);
  db.prepare(
    `INSERT INTO messages (student_id, sender, body, attachment_name, attachment_path, attachment_mime)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    studentId,
    sender,
    body,
    attachment ? attachment.attachment_name : null,
    attachment ? attachment.attachment_path : null,
    attachment ? attachment.attachment_mime : null
  );
}

module.exports = {
  ALLOWED_MIME_TYPES,
  getThread,
  toClientJson,
  getUnreadForAdmin,
  getUnreadForStudent,
  markReadForAdmin,
  markReadForStudent,
  saveAttachment,
  sendAttachment,
  insertMessage,
};
