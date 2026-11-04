// Sign-in page opened by the Qhint desktop app in the system browser (RFC 8252). After sign-in
// it hands the tokens to the app over a one-time loopback address, checked with a random state.
//
// Every customer company is its own Identity Platform tenant. Password and SSO sign-in look up
// the tenant for the typed email (/auth/discover) and set auth.tenantId before calling the
// Firebase SDK; lookups are cached per email and warmed when an email field loses focus, so the
// SSO pop-up can usually open straight from the click without being blocked.
//
// Google needs no email up front: the pop-up signs in at project level, which tells us the
// address, then that throwaway project user is deleted, the tenant is discovered, and the same
// Google credential signs in to the company's tenant without a second prompt.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  SAMLAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithCredential,
  signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  bad_credentials: 'Incorrect email or password.',
  password_disabled:
    "Password sign-in isn't enabled for your organization. Use one of the options below.",
  google_disabled: "Google sign-in isn't enabled for your organization.",
  sso_missing:
    "Single sign-on isn't set up for your organization yet. Ask your admin, or sign in with email and password.",
  unknown_workspace:
    "We couldn't find a Qhint workspace for that email. Check the address or ask your admin for an invite.",
  too_many: 'Too many attempts. Wait a moment or reset your password.',
  network: "We couldn't reach Qhint. Check your connection and try again.",
  popup_blocked:
    'Your browser blocked the sign-in window. Allow pop-ups for this page, then try again.',
  desktop_unreachable:
    "We couldn't hand the sign-in back to the Qhint app. Return to Qhint and start signing in again.",
  user_disabled: 'This account has been disabled. Contact your admin.',
  provider_unavailable:
    "This sign-in option isn't available for your organization right now. Try another option or ask your admin.",
  config: "Sign-in couldn't load. Refresh the page to try again.",
  not_invited: "That account isn't invited to this workspace yet. Ask your admin for an invite.",
  email_unverified: 'Your email address needs to be verified first.',
  account_conflict:
    'This email is already linked to a different sign-in method. Use that method, or contact your admin.',
  not_provisioned: "That account isn't set up for Qhint yet. Ask your admin.",
  google_other_method:
    'This email already uses a different sign-in method. Sign in with email and password.',
  google_unavailable:
    "Google sign-in isn't available for your organization yet. Contact your admin.",
  generic: 'Something went wrong. Please try again.',
};

const googleUnknownWorkspace = (email) =>
  `We couldn't find a Qhint workspace for ${email}. Ask your admin for an invite, or try another Google account.`;

const FIELD_MESSAGES = {
  email_required: 'Enter your work email.',
  email_invalid: 'Enter a valid work email, like name@company.com.',
  password_required: 'Enter your password.',
};

const RESET_SENT = "If an account exists for that email, we've sent a reset link.";
const DEFAULT_METHODS = { password: true, google: true, microsoft: false, sso: null };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class FlowError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const params = new URLSearchParams(location.search);
const port = Number(params.get('port'));
const state = params.get('state') ?? '';
const validRequest =
  Number.isInteger(port) && port >= 1024 && port <= 65535 && /^[A-Za-z0-9_-]{32,128}$/.test(state);

const normaliseEmail = (value) => value.trim();
const isEmail = (value) => value.length <= 254 && EMAIL_RE.test(value);

// ---------- UI helpers (textContent only, never HTML) ----------

function setNotice(kind, text) {
  $('error').textContent = kind === 'error' ? text : '';
  $('status').textContent = kind === 'status' ? text : '';
}

function showError(code) {
  setNotice('error', MESSAGES[code] ?? MESSAGES.generic);
}

function setFieldError(input, text) {
  const errorEl = $(`${input.id}-error`);
  errorEl.textContent = text;
  errorEl.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function clearFieldErrors() {
  for (const el of document.querySelectorAll('.field-error')) {
    el.textContent = '';
    el.hidden = true;
  }
  for (const input of document.querySelectorAll('input[aria-invalid]')) {
    input.removeAttribute('aria-invalid');
  }
}

function clearMessages() {
  setNotice('', '');
  clearFieldErrors();
}

// Marks both credential fields invalid and points them at the shared error message.
function flagCredentials() {
  for (const input of [$('email'), $('password')]) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', `${input.id}-error error`);
  }
  $('password').value = '';
  $('password').focus();
}

function resetDescribedBy() {
  for (const input of [$('email'), $('password')]) {
    input.setAttribute('aria-describedby', `${input.id}-error`);
  }
}

const VIEWS = {
  signin: { title: 'Sign in to Qhint', lead: 'Use your work account.', focus: 'email' },
  reset: {
    title: 'Reset your password',
    lead: "Enter your work email and we'll send you a link to choose a new password.",
    focus: 'reset-email',
  },
  sso: {
    title: 'Sign in with SSO',
    lead: "Enter your work email and we'll send you to your company's sign-in page.",
    focus: 'sso-email',
  },
};

let currentView = 'signin';

function currentEmail() {
  const id = currentView === 'signin' ? 'email' : `${currentView}-email`;
  return normaliseEmail($(id)?.value ?? '');
}

function showView(name) {
  const email = currentEmail();
  currentView = name;
  for (const view of Object.keys(VIEWS)) $(`view-${view}`).hidden = view !== name;
  $('footnote').hidden = false;
  $('title').textContent = VIEWS[name].title;
  $('lead').textContent = VIEWS[name].lead;
  document.title = VIEWS[name].title;
  clearMessages();
  resetDescribedBy();
  // Carry the email across views so the user never types it twice.
  for (const id of ['email', 'reset-email', 'sso-email']) $(id).value = email;
  const target = name === 'signin' && email ? $('password') : $(VIEWS[name].focus);
  target.focus();
}

function showDone(tenantName) {
  for (const view of Object.keys(VIEWS)) $(`view-${view}`).hidden = true;
  $('footnote').hidden = true;
  $('title').textContent = "You're signed in";
  $('lead').textContent = '';
  document.title = 'Signed in to Qhint';
  setNotice(
    'status',
    `Signed in to ${tenantName || 'Qhint'}. You can close this tab and return to Qhint.`,
  );
  $('title').focus();
}

function showBlocked(text) {
  for (const view of Object.keys(VIEWS)) $(`view-${view}`).hidden = true;
  $('footnote').hidden = true;
  $('lead').textContent = '';
  setNotice('error', text);
}

// One request at a time: every action is disabled while a flow runs and the clicked button
// shows progress. Inputs become read-only (not disabled) so focus and values are kept.
let busy = false;

async function withBusy(button, label, task) {
  if (busy) return;
  busy = true;
  const labelEl = button.querySelector('.label');
  const original = labelEl?.textContent;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };
  for (const el of document.querySelectorAll('[data-action]')) el.disabled = true;
  for (const el of document.querySelectorAll('input')) el.readOnly = true;
  button.setAttribute('aria-busy', 'true');
  button.prepend(spinner);
  $('card').setAttribute('aria-busy', 'true');
  setLabel(label);
  try {
    await task(setLabel);
  } finally {
    spinner.remove();
    setLabel(original);
    button.removeAttribute('aria-busy');
    $('card').removeAttribute('aria-busy');
    for (const el of document.querySelectorAll('[data-action]')) el.disabled = false;
    for (const el of document.querySelectorAll('input')) el.readOnly = false;
    busy = false;
  }
}

// ---------- Network ----------

async function post(url, body, token) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new FlowError('network');
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new FlowError(data?.error?.code ?? `http_${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function readMethods(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_METHODS };
  const sso =
    raw.sso &&
    (raw.sso.type === 'saml' || raw.sso.type === 'oidc') &&
    typeof raw.sso.providerId === 'string' &&
    raw.sso.providerId
      ? {
          type: raw.sso.type,
          providerId: raw.sso.providerId,
          label: typeof raw.sso.label === 'string' ? raw.sso.label : '',
        }
      : null;
  return {
    password: raw.password === true,
    google: raw.google === true,
    microsoft: raw.microsoft === true,
    sso,
  };
}

// Results (including "no such account") are cached per email for the life of the page.
const discoveries = new Map();

async function discover(email) {
  const key = email.toLowerCase();
  if (discoveries.has(key)) return discoveries.get(key);
  let result;
  try {
    const data = await post('/auth/discover', { email });
    if (typeof data.firebaseTenantId !== 'string' || !data.firebaseTenantId) {
      throw new FlowError('generic');
    }
    result = {
      found: true,
      firebaseTenantId: data.firebaseTenantId,
      tenantName: typeof data.tenantName === 'string' ? data.tenantName : '',
      methods: readMethods(data.methods),
    };
  } catch (err) {
    if (err.status !== 404 && err.code !== 'unknown_account') throw err;
    result = { found: false };
  }
  discoveries.set(key, result);
  return result;
}

function cachedDiscovery(email) {
  return discoveries.get(email.toLowerCase());
}

function prefetch(email) {
  if (isEmail(email) && !cachedDiscovery(email)) discover(email).catch(() => {});
}

// ---------- Firebase error mapping ----------

function authErrorCode(err) {
  if (err instanceof FlowError) return err.code;
  switch (err?.code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
    case 'auth/missing-password':
      return 'bad_credentials';
    case 'auth/too-many-requests':
      return 'too_many';
    case 'auth/network-request-failed':
    case 'auth/timeout':
      return 'network';
    case 'auth/popup-blocked':
      return 'popup_blocked';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return 'cancelled';
    case 'auth/user-disabled':
      return 'user_disabled';
    case 'auth/account-exists-with-different-credential':
    case 'auth/credential-already-in-use':
    case 'auth/email-already-in-use':
      return 'account_conflict';
    case 'auth/operation-not-allowed':
    case 'auth/invalid-tenant-id':
    case 'auth/tenant-id-mismatch':
    case 'auth/unauthorized-domain':
      return 'provider_unavailable';
    default:
      return 'generic';
  }
}

// ---------- Flows ----------

async function main() {
  if (!validRequest) {
    showBlocked('Open this page from the Qhint app to sign in.');
    return;
  }

  let auth;
  try {
    const res = await fetch('/login/config');
    if (!res.ok) throw new Error('config');
    const config = await res.json();
    auth = getAuth(
      initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
      }),
    );
    if (config.emulatorUrl) {
      connectAuthEmulator(auth, config.emulatorUrl, { disableWarnings: true });
    }
  } catch {
    showBlocked(MESSAGES.config);
    return;
  }

  const hinted = normaliseEmail(params.get('email') ?? '');
  if (isEmail(hinted)) {
    $('email').value = hinted;
    prefetch(hinted);
  }
  showView('signin');

  // Validates an email input; on failure marks the field and returns null.
  function readEmail(input, emptyMessage = FIELD_MESSAGES.email_required) {
    const email = normaliseEmail(input.value);
    if (!email) {
      setFieldError(input, emptyMessage);
      return null;
    }
    if (!isEmail(email)) {
      setFieldError(input, FIELD_MESSAGES.email_invalid);
      return null;
    }
    return email;
  }

  // Exchanges a fresh Firebase sign-in for a desktop session, then forgets it locally.
  async function finish(user, firebaseTenantId, setLabel) {
    setLabel('Signing in…');
    try {
      let idToken = await user.getIdToken();
      const session = await post('/auth/session', {}, idToken);
      if (session.status === 'refresh') idToken = await user.getIdToken(true);
      try {
        await post(`http://127.0.0.1:${port}/callback`, {
          state,
          idToken,
          refreshToken: user.refreshToken,
          firebaseTenantId,
          email: user.email,
        });
      } catch {
        throw new FlowError('desktop_unreachable');
      }
      showDone(session.tenantName);
    } finally {
      // The desktop app holds the session now (or sign-in failed); keep nothing in this browser.
      await auth.signOut().catch(() => {});
    }
  }

  function handleFailure(err) {
    const code = authErrorCode(err);
    if (code === 'cancelled') return; // user closed the pop-up: quietly go back to idle
    showError(code);
  }

  async function passwordSignIn() {
    clearMessages();
    resetDescribedBy();
    const email = readEmail($('email'));
    if (!email) return;
    const password = $('password').value;
    if (!password) return setFieldError($('password'), FIELD_MESSAGES.password_required);

    await withBusy($('signin'), 'Signing in…', async (setLabel) => {
      try {
        const found = await discover(email);
        if (!found.found) throw new FlowError('bad_credentials');
        if (!found.methods.password) throw new FlowError('password_disabled');
        auth.tenantId = found.firebaseTenantId;
        const credential = await signInWithEmailAndPassword(auth, email, password);
        await finish(credential.user, found.firebaseTenantId, setLabel);
      } catch (err) {
        const code = authErrorCode(err);
        showError(code);
        if (code === 'bad_credentials') flagCredentials();
      }
    });
  }

  // Opens a provider pop-up. If the tenant is already known the pop-up opens without awaiting
  // anything first, which keeps it inside the click's user activation in strict browsers.
  async function popupSignIn(button, email, pickProvider) {
    await withBusy(button, 'Finding your workspace…', async (setLabel) => {
      try {
        const found = cachedDiscovery(email) ?? (await discover(email));
        if (!found.found) throw new FlowError('unknown_workspace');
        const provider = pickProvider(found.methods);
        auth.tenantId = found.firebaseTenantId;
        setLabel('Continue in the pop-up…');
        const credential = await signInWithPopup(auth, provider);
        await finish(credential.user, found.firebaseTenantId, setLabel);
      } catch (err) {
        handleFailure(err);
      }
    });
  }

  // Google: the pop-up opens straight from the click (no email needed; a typed one is only a hint).
  async function googleSignIn() {
    clearMessages();
    resetDescribedBy();
    const typed = normaliseEmail($('email').value);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
      prompt: 'select_account',
      ...(isEmail(typed) ? { login_hint: typed } : {}),
    });

    await withBusy($('google'), 'Continue in the pop-up…', async (setLabel) => {
      try {
        auth.tenantId = null;
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        const email = result.user.email;
        // The project-level user only existed to learn the address; remove it right away.
        try {
          await result.user.delete();
        } catch {
          // Best effort: a leftover project-level user grants no access to any workspace.
        }
        await auth.signOut().catch(() => {});
        if (!credential || !email) throw new FlowError('generic');

        setLabel('Finding your workspace…');
        const found = await discover(email);
        if (!found.found) {
          setNotice('error', googleUnknownWorkspace(email));
          return;
        }
        if (!found.methods.google) throw new FlowError('google_disabled');

        auth.tenantId = found.firebaseTenantId;
        const signedIn = await signInWithCredential(auth, credential);
        await finish(signedIn.user, found.firebaseTenantId, setLabel);
      } catch (err) {
        await auth.signOut().catch(() => {});
        switch (err?.code) {
          case 'auth/account-exists-with-different-credential':
            return showError('google_other_method');
          case 'auth/admin-restricted-operation':
          case 'auth/operation-not-allowed':
            return showError('google_unavailable');
          default:
            return handleFailure(err);
        }
      }
    });
  }

  function ssoSignIn() {
    clearMessages();
    const email = readEmail($('sso-email'));
    if (!email) return;
    return popupSignIn($('sso-submit'), email, (methods) => {
      const sso = methods.sso;
      if (!sso) throw new FlowError('sso_missing');
      if (sso.type === 'saml') return new SAMLAuthProvider(sso.providerId);
      const provider = new OAuthProvider(sso.providerId);
      provider.setCustomParameters({ login_hint: email });
      return provider;
    });
  }

  async function sendReset() {
    clearMessages();
    const email = readEmail($('reset-email'));
    if (!email) return;
    await withBusy($('reset-submit'), 'Sending…', async () => {
      try {
        const found = await discover(email);
        if (found.found && found.methods.password) {
          auth.tenantId = found.firebaseTenantId;
          await sendPasswordResetEmail(auth, email);
        }
        setNotice('status', RESET_SENT);
      } catch (err) {
        const code = authErrorCode(err);
        // Same answer whether or not the account exists; only transient problems are surfaced.
        if (code === 'network' || code === 'too_many') showError(code);
        else setNotice('status', RESET_SENT);
      }
    });
  }

  // ---------- Wiring ----------

  $('signin-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void passwordSignIn();
  });
  $('reset-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void sendReset();
  });
  $('sso-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void ssoSignIn();
  });
  $('google').addEventListener('click', () => void googleSignIn());
  $('sso').addEventListener('click', () => showView('sso'));
  $('forgot').addEventListener('click', () => showView('reset'));
  for (const back of document.querySelectorAll('[data-back]')) {
    back.addEventListener('click', () => showView('signin'));
  }

  $('toggle-password').addEventListener('click', () => {
    const input = $('password');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const toggle = $('toggle-password');
    toggle.textContent = reveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(reveal));
    toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    input.focus();
  });

  for (const id of ['email', 'sso-email']) {
    $(id).addEventListener('blur', () => prefetch(normaliseEmail($(id).value)));
  }
  // Editing a field clears its own error so stale messages don't linger.
  for (const input of document.querySelectorAll('input')) {
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') !== 'true') return;
      input.removeAttribute('aria-invalid');
      const errorEl = $(`${input.id}-error`);
      errorEl.textContent = '';
      errorEl.hidden = true;
    });
  }
}

void main();
