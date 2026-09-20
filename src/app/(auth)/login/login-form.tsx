'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { login, type AuthState } from './actions';

export function LoginForm({
  next,
  demo,
}: {
  next?: string;
  demo: { email: string; password: string } | null;
}) {
  const [state, action, pending] = useActionState<AuthState, FormData>(login, {});
  const [email, setEmail] = React.useState(demo?.email ?? '');
  const [password, setPassword] = React.useState('');

  return (
    <>
      <form action={action} className="mt-7 space-y-4">
        {next && <input type="hidden" name="next" value={next} />}

        <Field label="Work email" error={state.fieldErrors?.['email']?.[0]}>
          <Input
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.['email'])}
          />
        </Field>

        <Field label="Password" error={state.fieldErrors?.['password']?.[0]}>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.['password'])}
          />
        </Field>

        {state.error && (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger-text"
          >
            {state.error}
          </p>
        )}

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {demo && (
        <div className="mt-6 rounded-[var(--radius-lg)] border border-accent-border bg-accent-subtle p-3.5">
          <p className="text-xs font-medium text-accent-text">Demo workspace</p>
          <p className="mt-1 text-2xs leading-relaxed text-accent-text/85 text-pretty">
            Northwind Labs — 28 accounts, 36 deals and 55 recorded meetings, with all AI memory
            derived by the real pipeline.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5 w-full"
            onClick={() => {
              setEmail(demo.email);
              setPassword(demo.password);
            }}
          >
            Fill demo credentials
          </Button>
          <p className="mt-2 font-mono text-[10px] text-accent-text/70">
            {demo.email} · {demo.password}
          </p>
        </div>
      )}
    </>
  );
}
