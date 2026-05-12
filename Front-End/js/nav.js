// Responsive nav helper. Looks for a header with .dashboard-nav and injects a
// hamburger toggle when there isn't one. Idempotent — safe to include on every
// page; does nothing on pages without the standard header.

(function() {
    document.addEventListener('DOMContentLoaded', () => {
        const header = document.querySelector('.dashboard-header');
        const nav    = header && header.querySelector('.dashboard-nav');
        if (!nav) return;
        if (header.querySelector('.nav-toggle')) return; // already installed

        const toggle = document.createElement('button');
        toggle.className = 'nav-toggle';
        toggle.setAttribute('aria-label', 'Toggle navigation');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<span class="nav-toggle-icon"><span></span></span>';

        toggle.addEventListener('click', () => {
            const open = nav.classList.toggle('is-open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        // The toggle sits between the logo and the nav so it shows up on the
        // right edge of the wrapped layout on narrow screens.
        header.insertBefore(toggle, nav);

        // Close the menu when a nav link is clicked (mobile UX).
        nav.addEventListener('click', e => {
            if (e.target.tagName === 'A' && nav.classList.contains('is-open')) {
                nav.classList.remove('is-open');
                toggle.setAttribute('aria-expanded', 'false');
            }
        });
    });
})();
