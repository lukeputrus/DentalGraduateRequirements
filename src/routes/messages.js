const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireStudent } = require('../middleware/auth');
const {
  ALLOWED_MIME_TYPES,
  getThread,
  toClientJson,
  getUnreadForStudent,
  markReadForStudent,
  sendAttachment,
  insertMessage,
} = require('../utils/messages');

const router = express.Router();
router.use(requireStudent);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

router.get('/messages/history', (req, res) => {
  const studentId = req.currentUser.id;
  const thread = getThread(studentId);
  markReadForStudent(studentId);
  res.json({ messages: thread.map(toClientJson) });
});

router.get('/messages/unread-count', (req, res) => {
  res.json({ count: getUnreadForStudent(req.currentUser.id) });
});

router.post('/messages/send', (req, res) => {
  upload.single('attachment')(req, res, (uploadErr) => {
    if (uploadErr) {
      const friendly =
        uploadErr.message === 'UNSUPPORTED_FILE_TYPE'
          ? 'Only PDF and image files (PNG, JPEG, WEBP, GIF) are supported.'
          : 'That file is too large (15MB max) or could not be uploaded.';
      return res.status(400).json({ error: friendly });
    }

    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Your session expired. Please refresh the page and try again.' });
    }

    const body = (req.body.message || '').trim();
    const file = req.file;
    if (!body && !file) {
      return res.status(400).json({ error: 'Type a message or attach a file first.' });
    }
    if (body.length > 4000) {
      return res.status(400).json({ error: 'Please keep messages under 4000 characters.' });
    }

    insertMessage({ studentId: req.currentUser.id, sender: 'student', body: body || '(sent an attachment)', file });
    res.json({ ok: true });
  });
});

router.get('/messages/attachment/:id', (req, res) => {
  const message = db
    .prepare('SELECT * FROM messages WHERE id = ? AND student_id = ?')
    .get(parseInt(req.params.id, 10), req.currentUser.id);
  if (!message) return res.status(404).end();
  sendAttachment(res, message);
});

module.exports = router;
