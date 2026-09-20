'use client';

import * as React from 'react';
import { ROLES } from '@/db/schema';
import { Select } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { updateMemberRoleAction } from '../actions';
import { titleCase } from '@/lib/utils';

export function RoleSelect({
  userId,
  currentRole,
  disabled,
}: {
  userId: string;
  currentRole: string;
  disabled?: boolean;
}) {
  const [role, setRole] = React.useState(currentRole);
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  const change = async (next: string) => {
    const previous = role;
    setRole(next);
    setPending(true);
    const result = await updateMemberRoleAction(userId, next);
    setPending(false);

    if (!result.ok) {
      // Revert so the control never shows a role the server refused.
      setRole(previous);
      toast({ title: 'Could not change the role', description: result.error, tone: 'error' });
      return;
    }
    toast({ title: result.message ?? 'Role updated.', tone: 'success' });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <Select
        value={role}
        onChange={(e) => change(e.target.value)}
        disabled={disabled || pending}
        className="h-7 w-auto min-w-24 text-xs"
        aria-label="Role"
        title={disabled ? 'You cannot change your own owner role' : undefined}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {titleCase(r)}
          </option>
        ))}
      </Select>
      {pending && <Spinner className="size-3 text-text-subtle" />}
    </span>
  );
}
