// RUKH legal pages: ruler cell of the section in view fills, count numerals lay like tape,
// the sticky contact tape slides in on phones after the hero has gone.
(() => {
  const rows = [...document.querySelectorAll('.count')];
  const cells = new Map([...document.querySelectorAll('.lg-ruler a')].map((a) => [a.getAttribute('href').slice(1), a]));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('IntersectionObserver' in window) {
    if (!reduce) {
      rows.forEach((r) => r.classList.add('pre'));
      const lay = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); e.target.classList.remove('pre'); lay.unobserve(e.target); }
      }), { rootMargin: '0px 0px -12% 0px' });
      rows.forEach((r) => lay.observe(r));
    }
    const spy = new IntersectionObserver((es) => es.forEach((e) => {
      const a = cells.get(e.target.id); if (!a) return;
      if (e.isIntersecting) { cells.forEach((c) => c.classList.remove('on')); a.classList.add('on'); }
    }), { rootMargin: '-35% 0px -55% 0px' });
    rows.forEach((r) => r.id && spy.observe(r));
  }
  const stick = document.getElementById('stick'), hero = document.querySelector('.lg-hero');
  if (stick && hero) {
    const upd = () => stick.classList.toggle('on', hero.getBoundingClientRect().bottom < innerHeight * 0.4);
    addEventListener('scroll', upd, { passive: true }); addEventListener('resize', upd); upd();
  }
})();
