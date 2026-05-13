// Inline toast notification system. Drop-in replacement for alert().
//
// Usage:
//   toast('Saved!');                       // default info style
//   toast('Saved!', { type: 'success' });
//   toast('Something failed', { type: 'error', duration: 6000 });
//
// Renders into #toast-container (auto-created on first call).

(function() {
    function container() {
        let el = document.getElementById('toast-container');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toast-container';
            el.setAttribute('aria-live', 'polite');
            el.setAttribute('aria-atomic', 'true');
            document.body.appendChild(el);
        }
        return el;
    }

    function toast(message, opts = {}) {
        const type = opts.type || 'info';   // info | success | error | warn
        const duration = opts.duration || 3500;

        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.textContent = message;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');

        container().appendChild(el);

        const removeAfter = (ms) => setTimeout(() => {
            el.classList.add('toast-fading');
            // Drop the element when the fade-out keyframe finishes.
            setTimeout(() => el.remove(), 320);
        }, ms);

        const timer = removeAfter(duration);

        // Click to dismiss early.
        el.addEventListener('click', () => {
            clearTimeout(timer);
            el.classList.add('toast-fading');
            setTimeout(() => el.remove(), 320);
        });

        return el;
    }

    window.toast = toast;
})();
