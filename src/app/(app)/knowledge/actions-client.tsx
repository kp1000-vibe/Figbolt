'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner, useToast } from '@/components/ui/feedback';
import { saveKnowledgeAction } from './actions';
import { Plus } from '@/components/layout/icons';

const CATEGORIES = [
  { value: 'product', label: 'Product' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'security', label: 'Security' },
  { value: 'playbook', label: 'Playbook' },
  { value: 'battlecard', label: 'Competitive battlecard' },
  { value: 'case_study', label: 'Case study' },
  { value: 'methodology', label: 'Qualification methodology' },
  { value: 'onboarding', label: 'Customer onboarding' },
  { value: 'other', label: 'Other' },
] as const;

export function KnowledgeActions({
  existing,
}: {
  existing?: { id: string; title: string; category: string; content: string; tags: string[] };
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant={existing ? 'secondary' : 'primary'} size="sm" onClick={() => setOpen(true)}>
        {!existing && <Plus />}
        {existing ? 'Edit document' : 'Add document'}
      </Button>
      {open && <KnowledgeModal existing={existing} onClose={() => setOpen(false)} />}
    </>
  );
}

function KnowledgeModal({
  existing,
  onClose,
}: {
  existing?: { id: string; title: string; category: string; content: string; tags: string[] };
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [title, setTitle] = React.useState(existing?.title ?? '');
  const [category, setCategory] = React.useState(existing?.category ?? 'product');
  const [content, setContent] = React.useState(existing?.content ?? '');
  const [tags, setTags] = React.useState((existing?.tags ?? []).join(', '));
  const [pending, setPending] = React.useState(false);

  const submit = async () => {
    setPending(true);
    const result = await saveKnowledgeAction({
      id: existing?.id,
      title,
      category,
      content,
      tags: tags.split(/\s*,\s*/).filter(Boolean),
    });
    setPending(false);

    if (!result.ok) {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
      return;
    }
    toast({ title: result.message ?? 'Saved.', tone: 'success' });
    onClose();
    if (result.data) router.push(`/knowledge/${result.data.id}`);
    else router.refresh();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Edit knowledge document' : 'Add knowledge document'}
      description="Saved content is chunked and embedded immediately, so agents can cite it on the next question."
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={pending || title.trim().length < 3 || content.trim().length < 40}
          >
            {pending && <Spinner className="size-3" />}
            {existing ? 'Save & re-index' : 'Add & index'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Tags" hint="Comma-separated. Used for filtering, not for retrieval.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="security, sso, soc2" />
        </Field>

        <Field
          label="Content"
          hint="Markdown headings become chunk headings, which improves how precisely an agent can cite this."
        >
          <Textarea
            rows={18}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono text-xs leading-relaxed"
            placeholder={'# Section\n\nWhat an agent needs to know…'}
          />
        </Field>
      </div>
    </Modal>
  );
}
