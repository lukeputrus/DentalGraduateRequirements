document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-percent]').forEach(function (el) {
    el.style.width = el.getAttribute('data-percent') + '%';
  });
});
