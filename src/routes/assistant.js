const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireStudent } = require('../middleware/auth');
const { askAssistant, isConfigured } = require('../utils/anthropic');

const router = express.Router();
router.use(requireStudent);

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

router.get('/assistant/history', (req, res) => {
  const messages = db
    .prepare('SELECT role, content, attachment_name, created_at FROM chat_messages WHERE student_id = ? ORDER BY id')
    .all(req.currentUser.id);
  res.json({ messages, configured: isConfigured() });
});

router.post('/assistant/message', (req, res) => {
  upload.single('attachment')(req, res, async (uploadErr) => {
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

    const student = req.currentUser;
    const message = (req.body.message || '').trim();
    const file = req.file;

    if (!message && !file) {
      return res.status(400).json({ error: 'Type a question or attach a file first.' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'Please keep questions under 4000 characters.' });
    }

    db.prepare('INSERT INTO chat_messages (student_id, role, content, attachment_name) VALUES (?, ?, ?, ?)').run(
      student.id,
      'user',
      message || '(sent an attachment)',
      file ? file.originalname : null
    );

    const saveAssistantReply = (text) => {
      db.prepare('INSERT INTO chat_messages (student_id, role, content) VALUES (?, ?, ?)').run(student.id, 'assistant', text);
      return text;
    };

    if (!isConfigured()) {
      const reply = saveAssistantReply(
        "The AI assistant isn't set up yet — ask your program administrator to add an Anthropic API key."
      );
      return res.json({ reply });
    }

    try {
      const history = db
        .prepare('SELECT role, content FROM chat_messages WHERE student_id = ? ORDER BY id DESC LIMIT 41')
        .all(student.id)
        .reverse();
      history.pop(); // drop the user message we just inserted; askAssistant adds it back with attachment content

      const reply = saveAssistantReply(await askAssistant({ student, history, message, file }));
      res.json({ reply });
    } catch (err) {
      console.error('Assistant error:', err.status || '', err.message);
      const reply = saveAssistantReply("Sorry, I couldn't process that right now. Please try again in a moment.");
      res.status(502).json({ reply });
    }
  });
});

module.exports = router;
