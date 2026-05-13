// Tidio live-chat widget integration.
//
// 1. Injects the Tidio loader script (async, protocol-relative so it works on
//    both HTTP and HTTPS).
// 2. Once Tidio is initialized, if the visitor is signed in, passes their
//    name / email / user id to Tidio so the support agent sees who's chatting.
// 3. Re-sends the identity when the visitor logs in or out within the SPA
//    (best-effort — Tidio doesn't expose a "logout" so we set anonymous data).
//
// The public key in the URL is fine to commit — that's how Tidio is designed.
// Private keys (Client Secret, Project Private Key) live in AWS Secrets
// Manager when needed for server-side API calls (webhooks, programmatic
// message send). We don't need them for the chat bubble itself.

(function() {
    const TIDIO_PUBLIC_KEY = 'vj3tpoepgvu8yreolkpp5k6hbxkmctfe';

    function injectScript() {
        if (document.querySelector('script[data-tidio]')) return;
        const s = document.createElement('script');
        s.src = '//code.tidio.co/' + TIDIO_PUBLIC_KEY + '.js';
        s.async = true;
        s.dataset.tidio = '1';
        document.head.appendChild(s);
    }

    function setIdentity() {
        // api.getUser() comes from js/api.js — only present on pages that load it.
        if (typeof api === 'undefined' || !api.isLoggedIn()) return;
        const u = api.getUser();
        if (!u) return;
        try {
            window.tidioChatApi.setVisitorData({
                distinct_id: String(u.id),
                email:        u.email || '',
                name:         [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '',
                phone:        u.phone || ''
            });
            // Tidio "tags" let support filter by attribute. Useful for admins.
            const tags = ['member'];
            if (u.role === 'admin') tags.push('admin');
            window.tidioChatApi.setContactProperties({ role: u.role || 'user' });
            window.tidioChatApi.addVisitorTags && window.tidioChatApi.addVisitorTags(tags);
        } catch (e) {
            // Tidio API not ready yet — the ready event listener will retry.
        }
    }

    // Tidio fires this on `document` when its widget finishes initializing.
    document.addEventListener('tidioChat-ready', setIdentity);

    // Inject as early as we can (script is async so this doesn't block render).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectScript);
    } else {
        injectScript();
    }
})();
