// API client with authentication and XSS-safe output
const API_BASE = '/api';

const api = {
    getToken() {
        return localStorage.getItem('sparko_token');
    },

    setToken(token) {
        localStorage.setItem('sparko_token', token);
    },

    setUser(user) {
        localStorage.setItem('sparko_user', JSON.stringify(user));
    },

    getUser() {
        const data = localStorage.getItem('sparko_user');
        return data ? JSON.parse(data) : null;
    },

    logout() {
        localStorage.removeItem('sparko_token');
        localStorage.removeItem('sparko_user');
        window.location.href = '/login.html';
    },

    isLoggedIn() {
        return !!this.getToken();
    },

    isAdmin() {
        const user = this.getUser();
        return user && user.role === 'admin';
    },

    async request(method, path, body = null) {
        const headers = { 'Content-Type': 'application/json' };
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const options = { method, headers };
        if (body) {
            options.body = JSON.stringify(body);
        }

        const res = await fetch(`${API_BASE}${path}`, options);

        if (res.status === 401) {
            this.logout();
            return;
        }

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || data.errors?.map(e => e.msg).join(', ') || 'Request failed');
        }

        return data;
    },

    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    delete(path) { return this.request('DELETE', path); }
};

// XSS protection: escape HTML before inserting into DOM
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// Safe text content setter (preferred over innerHTML)
function setText(el, text) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (el) el.textContent = text;
}

// Redirect helpers for route protection
function requireAuth() {
    if (!api.isLoggedIn()) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function requireAdmin() {
    if (!api.isLoggedIn() || !api.isAdmin()) {
        window.location.href = '/dashboard.html';
        return false;
    }
    return true;
}

function redirectIfLoggedIn() {
    if (api.isLoggedIn()) {
        window.location.href = api.isAdmin() ? '/admin/dashboard.html' : '/dashboard.html';
        return true;
    }
    return false;
}

function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function formatCurrency(amount) {
    return '$' + parseFloat(amount).toFixed(2);
}

function statusBadge(status) {
    return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(status.replace('_', ' '))}</span>`;
}
