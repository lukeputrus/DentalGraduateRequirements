document.addEventListener('DOMContentLoaded', function () {
  const root = document.getElementById('assistant-root');
  if (!root) return;

  const csrfToken = root.getAttribute('data-csrf');
  const toggleBtn = document.getElementById('assistant-toggle');
  const panel = document.getElementById('assistant-panel');
  const closeBtn = document.getElementById('assistant-close');
  const messagesEl = document.getElementById('assistant-messages');
  const form = document.getElementById('assistant-form');
  const textInput = document.getElementById('assistant-text-input');
  const fileInput = document.getElementById('assistant-file-input');
  const attachBtn = document.getElementById('assistant-attach-btn');
  const fileNameEl = document.getElementById('assistant-file-name');

  let historyLoaded = false;

  function addMessage(role, text, attachmentName) {
    const div = document.createElement('div');
    div.className = 'assistant-msg ' + role;
    div.textContent = text;
    if (attachmentName) {
      const note = document.createElement('span');
      note.className = 'attachment-note';
      note.textContent = 'Attached: ' + attachmentName;
      div.appendChild(note);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    fetch('/student/assistant/history')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.messages && data.messages.length) {
          data.messages.forEach(function (m) { addMessage(m.role, m.content, m.attachment_name); });
        } else {
          addMessage('assistant', 'Hi! Ask me anything about your competency requirements, or attach a document or image you have a question about.');
        }
      })
      .catch(function () {
        addMessage('error', 'Could not load your conversation history.');
      });
  }

  function openPanel() {
    panel.classList.add('open');
    loadHistory();
    textInput.focus();
  }
  function closePanel() {
    panel.classList.remove('open');
  }

  toggleBtn.addEventListener('click', function () {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  attachBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    fileNameEl.textContent = fileInput.files[0] ? fileInput.files[0].name : '';
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const text = textInput.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return;

    addMessage('user', text || '(sent an attachment)', file ? file.name : null);
    const typingEl = addMessage('assistant', 'Thinking…');
    typingEl.classList.add('assistant-typing');

    const formData = new FormData();
    formData.append('_csrf', csrfToken);
    formData.append('message', text);
    if (file) formData.append('attachment', file);

    textInput.value = '';
    fileInput.value = '';
    fileNameEl.textContent = '';
    textInput.disabled = true;

    fetch('/student/assistant/message', { method: 'POST', body: formData })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        typingEl.remove();
        if (result.data && result.data.reply) {
          addMessage(result.ok ? 'assistant' : 'error', result.data.reply);
        } else {
          addMessage('error', (result.data && result.data.error) || 'Something went wrong.');
        }
      })
      .catch(function () {
        typingEl.remove();
        addMessage('error', 'Network error — please try again.');
      })
      .finally(function () {
        textInput.disabled = false;
        textInput.focus();
      });
  });
});
