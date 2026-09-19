const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { getStudentCompetencies, summarize, STATUS_LABELS } = require('./competencies');

const MODEL = 'claude-opus-5';
const HISTORY_LIMIT = 20;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function buildSystemPrompt(student) {
  const school = db.prepare('SELECT name FROM schools WHERE id = ?').get(student.school_id);
  const competencies = getStudentCompetencies(student);
  const summary = summarize(competencies);

  const lines = [
    `You are a helpful academic assistant embedded in a graduation requirements tracker, helping ${student.full_name}, a dental student at ${school ? school.name : 'their dental school'} in the Class of ${student.class_year}.`,
    'Answer questions about their competency requirements and general dental-school academic questions. Be concise, warm, and encouraging.',
    `Overall progress: ${summary.passed} passed, ${summary.eligible} eligible/ready for exam, ${summary.prereqs_in_progress} with prerequisites in progress, ${summary.not_started} not started, ${summary.needs_retest} needing a retest, out of ${summary.total} total competencies.`,
    '',
    'Current competency list (category, dental year, title: status; remaining prerequisite items; due date if known):',
  ];

  for (const c of competencies) {
    const remaining = c.items
      .filter((i) => i.current_count < i.target_count)
      .map((i) => `${i.label} (${i.current_count}/${i.target_count})`);
    lines.push(
      `- [${c.category}${c.dental_year ? ', ' + c.dental_year : ''}] ${c.title}: ${STATUS_LABELS[c.status]}` +
        (remaining.length ? `; remaining: ${remaining.join(', ')}` : '') +
        (c.due_label ? `; ${c.due_label}` : '')
    );
  }

  lines.push(
    '',
    "Use this data to answer what they still need to do. If asked something this data doesn't cover (exact clinic scheduling, faculty assignments, grade appeals, policy exceptions), say you don't have that information and suggest contacting their program administrator. If they attach a document or image, use it to answer their question. Never invent specific program policy you weren't given."
  );

  return lines.join('\n');
}

async function askAssistant({ student, history, message, file }) {
  const anthropic = getClient();
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const content = [];
  if (file) {
    if (file.mimetype === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') },
      });
    } else {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') },
      });
    }
  }
  content.push({ type: 'text', text: message || 'Please look at the attached file and summarize it for me.' });

  const messages = history.slice(-HISTORY_LIMIT).map((h) => ({ role: h.role, content: h.content }));
  messages.push({ role: 'user', content });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(student),
    output_config: { effort: 'medium' },
    messages,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : "I'm not sure how to respond to that — could you rephrase?";
}

module.exports = { askAssistant, isConfigured, MODEL };
