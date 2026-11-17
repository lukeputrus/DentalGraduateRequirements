// Small progressive enhancements. Every page works without them.
document.addEventListener('DOMContentLoaded', function () {
  // Selects that apply as soon as they change (filters, theme, role).
  document.querySelectorAll('select[data-autosubmit]').forEach(function (select) {
    select.addEventListener('change', function () {
      if (select.form) select.form.submit();
    });
  });

  // Live search over [data-search] rows inside the target container.
  document.querySelectorAll('input[data-live-search]').forEach(function (input) {
    var target = document.querySelector(input.getAttribute('data-live-search'));
    if (!target) return;
    var rows = target.querySelectorAll('[data-search]');
    var empty = document.getElementById(target.id.replace(/-(table|list)$/, '') + '-empty');
    function apply() {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (row) {
        var hit = !q || (row.getAttribute('data-search') || '').indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown++;
      });
      target.querySelectorAll('[data-search-group]').forEach(function (group) {
        group.hidden = !group.querySelector('[data-search]:not([hidden])');
      });
      if (empty) empty.hidden = shown > 0;
    }
    input.addEventListener('input', apply);
    // The server already filtered by the submitted query, so live search
    // only needs to refine what's on the page.
  });

  document.querySelectorAll('[data-print]').forEach(function (button) {
    button.addEventListener('click', function () { window.print(); });
  });
});
