'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, CopyButton, Modal, Spinner, useToast } from '@/components/ui/feedback';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { Plus, Trash } from '@/components/layout/icons';
import { relativeTime, shortDate, titleCase } from '@/lib/utils';
import { createApiKeyAction, revokeApiKeyAction } from './keys-actions';

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  role: string;
  lastUsedAt: Date | null;
  useCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
};

/**
 * API keys.
 *
 * Keys are what make the CRM usable by things that are not this web app — the
 * CLI, the MCP server, another team's agent. They carry a role, and that role
 * is clamped to the live role of whoever created the key on every request, so
 * a key cannot outlive its creator's authority.
 */
export function ApiKeysPanel({ keys, maxRole }: { keys: ApiKeyRow[]; maxRole: string }) {
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<{ plaintext: string; name: string } | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const create = async (form: FormData) => {
    setBusy(true);
    const expires = String(form.get('expiresInDays') ?? '');
    const result = await createApiKeyAction({
      name: String(form.get('name') ?? ''),
      role: String(form.get('role') ?? 'member'),
      expiresInDays: expires === 'never' ? null : Number(expires),
    });
    setBusy(false);

    if (!result.ok) {
      toast({ tone: 'error', title: 'Could not create key', description: result.error });
      return;
    }
    setCreating(false);
    if (result.data) setIssued({ plaintext: result.data.plaintext, name: result.data.name });
    router.refresh();
  };

  const revoke = async (key: ApiKeyRow) => {
    setBusy(true);
    const result = await revokeApiKeyAction(key.id);
    setBusy(false);
    toast(
      result.ok
        ? { tone: 'success', title: `Revoked "${key.name}"`, description: result.message }
        : { tone: 'error', title: 'Could not revoke key', description: result.error },
    );
    router.refresh();
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>API keys</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            For the CLI, the MCP server and other agents. Stored as a SHA-256 hash — the key itself
            is shown once and never again.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          New key
        </Button>
      </CardHeader>

      <CardBody className="px-0 pt-0 pb-0">
        {keys.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-text-subtle">
            No API keys yet. Create one to use <code className="font-mono">npm run cli</code> or to
            let another agent read and write this workspace over MCP.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Role</Th>
                <Th>Last used</Th>
                <Th>Requests</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {keys.map((key) => {
                const expired = key.expiresAt != null && key.expiresAt.getTime() < Date.now();
                return (
                  <Tr key={key.id}>
                    <Td>
                      <span className="font-medium text-text">{key.name}</span>
                      <span className="block text-2xs text-text-subtle">
                        by {key.createdByName ?? 'unknown'} · {shortDate(key.createdAt)}
                      </span>
                    </Td>
                    <Td>
                      <code className="font-mono text-2xs text-text-muted">{key.prefix}…</code>
                    </Td>
                    <Td>{titleCase(key.role)}</Td>
                    <Td>{key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never'}</Td>
                    <Td>{key.useCount.toLocaleString()}</Td>
                    <Td>
                      {key.revokedAt ? (
                        <Badge tone="neutral" size="sm">
                          Revoked
                        </Badge>
                      ) : expired ? (
                        <Badge tone="warning" size="sm">
                          Expired
                        </Badge>
                      ) : (
                        <Badge tone="success" size="sm">
                          Active
                        </Badge>
                      )}
                    </Td>
                    <Td align="right">
                      {!key.revokedAt && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => revoke(key)}
                          aria-label={`Revoke ${key.name}`}
                        >
                          <Trash className="size-3.5" />
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </CardBody>

      {/* ── Create ──────────────────────────────────────────────────────── */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New API key"
        description="The key inherits the role you choose, capped at your own. It can never do more than you can."
      >
        <form action={create} className="space-y-4">
          <Field label="Name" hint="What will use this key — a machine, a script, an agent.">
            <Input name="name" required maxLength={80} placeholder="CLI on my laptop" autoFocus />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role" hint={`Capped at your role (${titleCase(maxRole)}).`}>
              <Select name="role" defaultValue="member">
                <option value="viewer">Viewer — read only</option>
                <option value="member">Member — read and write</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>

            <Field label="Expires">
              <Select name="expiresInDays" defaultValue="90">
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In a year</option>
                <option value="never">Never</option>
              </Select>
            </Field>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy && <Spinner className="size-3.5" />}
              Create key
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Show once ───────────────────────────────────────────────────── */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="Copy your key now"
        description="This is the only time it will be shown. Nexus stores only a hash of it."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-2xs text-text">
              {issued?.plaintext}
            </code>
            <CopyButton value={issued?.plaintext ?? ''} label="Copy" />
          </div>

          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <p className="text-2xs font-medium text-text">Use it from the CLI</p>
            <pre className="mt-1.5 overflow-x-auto font-mono text-2xs text-text-muted">
              {`export NEXUS_API_KEY=${issued?.plaintext ?? ''}\nnpm run cli -- accounts:list`}
            </pre>
          </div>

          <p className="text-2xs text-text-subtle">
            High-risk actions taken with this key still require a human approval in the Inbox — an
            API key does not bypass the approval gate.
          </p>

          <div className="flex justify-end border-t border-border pt-3">
            <Button size="sm" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
