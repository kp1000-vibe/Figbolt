'use client';

import { useActionState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { signup, type AuthState } from '../login/actions';

export function SignupForm() {
  const [state, action, pending] = useActionState<AuthState, FormData>(signup, {});

  return (
    <form action={action} className="mt-7 space-y-4">
      <Field label="Your name" error={state.fieldErrors?.['name']?.[0]}>
        <Input name="name" autoComplete="name" required autoFocus placeholder="Alex Rivera" />
      </Field>

      <Field label="Work email" error={state.fieldErrors?.['email']?.[0]}>
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="you@company.com"
        />
      </Field>

      <Field
        label="Password"
        hint="At least 10 characters. Length matters more than symbols."
        error={state.fieldErrors?.['password']?.[0]}
      >
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          placeholder="••••••••••"
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
        {pending ? 'Creating…' : 'Create workspace'}
      </Button>
    </form>
  );
}
