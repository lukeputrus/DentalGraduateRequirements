document.addEventListener('submit', function (event) {
  var form = event.target;
  var submitter = event.submitter;
  var message = (submitter && submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) {
    event.preventDefault();
  }
});
