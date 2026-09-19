document.addEventListener('DOMContentLoaded', function () {
  const root = document.getElementById('msg-root');
  if (!root) return;

  const csrfToken = root.getAttribute('data-csrf');
  const toggleBtn = document.getElementById('msg-toggle');
  const dot = document.getElementById('msg-dot');
  const panel = document.getElementById('msg-panel');
  const closeBtn = document.getElementById('msg-close');
  const messagesEl = document.getElementById('msg-messages');
  const form = document.getElementById('msg-form');
  const textInput = document.getElementById('msg-text-input');
  const fileInput = document.getElementById('msg-file-input');
  const attachBtn = document.getElementById('msg-attach-btn');
  const fileNameEl = document.getElementById('msg-file-name');

  function addMessage(sender, body, attachmentName, messageId) {
    const div = document.createElement('div');
    div.className = 'assistant-msg ' + (sender === 'student' ? 'user' : 'assistant');
    div.textContent = body;
    if (attachmentName) {
      const link = document.createElement('a');
      link.className = 'attachment-note';
      link.href = '/student/messages/attachment/' + messageId;
      link.textContent = 'Download attachment: ' + attachmentName;
      link.style.color = 'inherit';
      div.appendChild(document.createElement('br'));
      div.appendChild(link);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function loadHistory() {
    fetch('/student/messages/history')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length) {
          data.messages.forEach(function (m) { addMessage(m.sender, m.body, m.attachment_name, m.id); });
        } else {
          addMessage('admin', "Have a question for your program administrator? Send a message here — they'll see it and reply here when they can.");
        }
        setDot(false);
      })
      .catch(function () {
        addMessage('admin', 'Could not load your messages right now.');
      });
  }

  function checkUnread() {
    fetch('/student/messages/unread-count')
      .then(function (r) { return r.json(); })
      .then(function (data) { setDot(!!(data && data.count > 0)); })
      .catch(function () {});
  }

  function setDot(show) {
    dot.hidden = !show;
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

    const formData = new FormData();
    formData.append('_csrf', csrfToken);
    formData.append('message', text);
    if (file) formData.append('attachment', file);

    textInput.value = '';
    fileInput.value = '';
    fileNameEl.textContent = '';
    textInput.disabled = true;

    fetch('/student/messages/send', { method: 'POST', body: formData })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        if (result.ok) {
          loadHistory();
        } else {
          addMessage('admin', (result.data && result.data.error) || 'Something went wrong sending that.');
        }
      })
      .catch(function () {
        addMessage('admin', 'Network error — please try again.');
      })
      .finally(function () {
        textInput.disabled = false;
        textInput.focus();
      });
  });

  checkUnread();
  setInterval(checkUnread, 45000);
});
