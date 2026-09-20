import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { getContactFacets, listContacts } from '@/server/crm/contacts';
import { PageShell } from '@/components/layout/app-shell';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { ContactFiltersBar } from './filters';
import { NavIcon } from '@/components/layout/icons';
import { number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Contacts' };

const ROLE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  champion: 'success',
  economic_buyer: 'accent',
  decision_maker: 'accent',
  technical_evaluator: 'info',
  blocker: 'danger',
  influencer: 'neutral',
  end_user: 'neutral',
};

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [{ rows, total }, facets] = await Promise.all([
    listContacts(ctx, {
      query: params['q'],
      buyingRole: params['role'],
      seniority: params['seniority'],
      ownerId: params['owner'],
      sort: (params['sort'] as 'name' | 'influence' | 'activity' | 'account') ?? 'name',
      limit: 200,
    }),
    getContactFacets(ctx),
  ]);

  const mapped = rows.filter((r) => r.buyingRole && r.buyingRole !== 'unknown').length;

  return (
    <PageShell wide>
      <PageHeader
        title="Contacts"
        description={`${number(total)} people · ${number(mapped)} with a buying role identified from conversations`}
      />

      <div className="mt-5">
        <ContactFiltersBar facets={facets} current={params} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="users" />}
          title="No contacts match"
          description="Try clearing a filter or searching for a different name."
        />
      ) : (
        <Card className="mt-4 overflow-hidden">
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th>Name</Th>
                <Th>Account</Th>
                <Th>Role in deal</Th>
                <Th>Title</Th>
                <Th align="right">Influence</Th>
                <Th align="right">Last contact</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((contact) => (
                <Tr key={contact.id}>
                  <Td>
                    <Link href={`/contacts/${contact.id}`} className="group flex items-center gap-2.5">
                      <Avatar name={`${contact.firstName} ${contact.lastName}`} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text group-hover:text-accent-text">
                          {contact.firstName} {contact.lastName}
                        </span>
                        {contact.email && (
                          <span className="block truncate text-2xs text-text-subtle">
                            {contact.email}
                          </span>
                        )}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    {contact.accountId ? (
                      <Link
                        href={`/accounts/${contact.accountId}`}
                        className="text-xs text-text-muted hover:text-accent-text"
                      >
                        {contact.accountName}
                      </Link>
                    ) : (
                      <span className="text-xs text-text-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    {contact.buyingRole && contact.buyingRole !== 'unknown' ? (
                      <Badge tone={ROLE_TONE[contact.buyingRole] ?? 'neutral'}>
                        {titleCase(contact.buyingRole)}
                      </Badge>
                    ) : (
                      <span className="text-2xs text-text-subtle">Not identified</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-xs text-text-muted">{contact.title ?? '—'}</span>
                  </Td>
                  <Td align="right">
                    <span className="text-xs text-text-muted">{contact.influence ?? '—'}</span>
                  </Td>
                  <Td align="right">
                    <span className="text-xs text-text-muted">
                      {relativeTime(contact.lastInteractionAt)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </PageShell>
  );
}
