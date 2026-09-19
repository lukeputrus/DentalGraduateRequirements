document.addEventListener('DOMContentLoaded', function () {
  const search = document.getElementById('comp-search');
  const chips = document.querySelectorAll('.filter-chip');
  const cards = document.querySelectorAll('.competency-card');
  if (!search && chips.length === 0) return;

  let activeFilter = 'all';

  function applyFilters() {
    const query = (search && search.value || '').trim().toLowerCase();
    cards.forEach(function (card) {
      const matchesStatus = activeFilter === 'all' || card.getAttribute('data-status') === activeFilter;
      const matchesSearch = !query || (card.getAttribute('data-search') || '').includes(query);
      card.style.display = matchesStatus && matchesSearch ? '' : 'none';
    });
    document.querySelectorAll('.competency-category-block').forEach(function (section) {
      const visible = Array.from(section.querySelectorAll('.competency-card')).some(function (card) {
        return card.style.display !== 'none';
      });
      section.style.display = visible ? '' : 'none';
    });
  }

  if (search) search.addEventListener('input', applyFilters);

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      activeFilter = chip.getAttribute('data-filter');
      applyFilters();
    });
  });
});
