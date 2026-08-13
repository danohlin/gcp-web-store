import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { auth } from '../api/endpoints';
import { ApiError } from '../api/client';
import { useAuth } from '../store/AuthContext';
import { Alert, Field } from '../components/ui';

function useRedirectTarget(): string {
  const location = useLocation() as { state?: { from?: { pathname: string } } };
  return location.state?.from?.pathname ?? '/';
}

export function LoginPage() {
  const navigate = useNavigate();
  const target = useRedirectTarget();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel stack" style={{ maxWidth: 420, marginInline: 'auto' }}>
      <h1>Sign in</h1>

      {error && <Alert>{error}</Alert>}

      <form className="stack" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn btn--block" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="muted">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="muted">
        No account yet? <Link to="/register">Create one</Link>.
      </p>
    </div>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await register({
        email: form.email,
        password: form.password,
        firstName: form.firstName || undefined,
        lastName: form.lastName || undefined,
      });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="panel stack" style={{ maxWidth: 460, marginInline: 'auto' }}>
      <h1>Create an account</h1>

      {error && <Alert>{error}</Alert>}

      <form className="stack" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="field-grid">
          <Field label="First name" autoComplete="given-name" value={form.firstName} onChange={update('firstName')} />
          <Field label="Last name" autoComplete="family-name" value={form.lastName} onChange={update('lastName')} />
        </div>
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          error={fieldErrors.email}
          onChange={update('email')}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          error={fieldErrors.password}
          hint="At least 10 characters."
          onChange={update('password')}
        />
        <button type="submit" className="btn btn--block" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="muted">
        Already registered? <Link to="/login">Sign in</Link>.
      </p>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await auth.forgotPassword({ email });
      setMessage(res.message);
      setDevToken(res.devToken ?? null);
    } catch {
      // The endpoint is deliberately uninformative; treat any failure the same.
      setMessage('If an account exists for that address, a reset link has been sent.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel stack" style={{ maxWidth: 460, marginInline: 'auto' }}>
      <h1>Reset your password</h1>

      {message && <Alert variant="success">{message}</Alert>}

      {devToken && (
        <Alert variant="warning">
          Email delivery is not wired up yet, so here is the reset link for local testing:{' '}
          <Link to={`/reset-password?token=${encodeURIComponent(devToken)}`}>Reset password</Link>
        </Alert>
      )}

      <form className="stack" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" className="btn btn--block" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <p className="muted">
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await auth.resetPassword({ token, password });
      navigate('/login', {
        replace: true,
        state: { notice: 'Password updated. Please sign in.' },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not reset your password. Please request a new link.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="panel stack" style={{ maxWidth: 460, marginInline: 'auto' }}>
        <h1>Reset your password</h1>
        <Alert>This link is missing its token. Request a new one.</Alert>
        <p>
          <Link to="/forgot-password">Request a reset link</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ maxWidth: 460, marginInline: 'auto' }}>
      <h1>Choose a new password</h1>

      {error && <Alert>{error}</Alert>}

      <form className="stack" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          error={fieldErrors.password}
          hint="At least 10 characters."
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn btn--block" disabled={submitting}>
          {submitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </div>
  );
}
