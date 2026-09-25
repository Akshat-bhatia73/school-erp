import { z } from 'zod'
import {
  InboxList,
  MESSAGE_KIND_LABELS,
  MessageAudienceKind,
  MessageDetail,
  MessageKind,
  MessageList,
  MessageStatus,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  IdInput,
  PAGE_SIZE,
  appPath,
  clip,
  datetime,
  fact,
  fetchParsed,
  humanise,
  num,
  ok,
  recordCard,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
} from './present.ts'

export const myInbox = readTool({
  name: 'my_inbox',
  description: 'Messages sent to the person asking: notices, absence alerts, results, fee reminders. Newest first, 50 at a time, with the unread count.',
  permission: 'communication.read',
  input: z.object({
    unreadOnly: z.boolean().optional().describe('Only messages not read yet.'),
    kind: MessageKind.optional().describe('Only this kind of message.'),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const found = await fetchParsed(context, InboxList, '/messages/inbox', {
      page,
      pageSize: PAGE_SIZE,
      kind: input.kind,
      show: input.unreadOnly ? 'unread' : 'all',
    })
    if (!found.ok) return found.outcome
    const body = found.body
    return ok(
      {
        unread: body.unread,
        total: body.total,
        messages: body.items.map((item) => ({
          messageId: item.messageId,
          kind: item.kind,
          title: item.title,
          preview: item.preview,
          sentAt: item.sentAt,
          read: item.readAt !== undefined,
          from: item.sender.name,
          pupil: item.pupil?.name,
        })),
        morePages: page * PAGE_SIZE < body.total,
      },
      tableCard({
        title: 'Inbox',
        columns: [
          { key: 'title', label: 'Message' },
          { key: 'kind', label: 'Kind' },
          { key: 'from', label: 'From' },
          { key: 'sent', label: 'Sent' },
          { key: 'read', label: 'Status' },
        ],
        rows: body.items.map((item) => ({
          cells: {
            title: text(item.title || 'Untitled'),
            kind: tag(MESSAGE_KIND_LABELS[item.kind]),
            from: text(item.sender.name),
            sent: datetime(item.sentAt),
            read: tag(item.readAt ? 'Read' : 'Unread'),
          },
          href: `/messages/${seg(item.messageId)}`,
        })),
        total: body.total,
      }),
      source('Inbox', appPath('/messages', { unread: input.unreadOnly ? 'true' : undefined, kind: input.kind })),
    )
  },
})

export const listMessages = readTool({
  name: 'list_messages',
  description:
    'Messages the school has sent or drafted that you may see, 50 at a time: yours only, or everyone\'s. Filter by kind, status, audience or words in the title.',
  permission: 'communication.read',
  input: z.object({
    mine: z.boolean().optional().describe('Only messages the person asking wrote.'),
    status: MessageStatus.optional().describe('Only this status.'),
    kind: MessageKind.optional().describe('Only this kind.'),
    audience: MessageAudienceKind.optional().describe('Only this kind of audience.'),
    search: z.string().trim().min(1).max(100).optional().describe('Words in the title.'),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const found = await fetchParsed(context, MessageList, '/messages', {
      page,
      pageSize: PAGE_SIZE,
      author: input.mine ? 'mine' : 'anyone',
      status: input.status,
      kind: input.kind,
      audience: input.audience,
      q: input.search,
    })
    if (!found.ok) return found.outcome
    const body = found.body
    return ok(
      {
        total: body.total,
        messages: body.items.map((item) => ({
          messageId: item.id,
          kind: item.kind,
          title: item.title,
          status: item.status,
          audience: item.audience.label,
          from: item.sender.name,
          sentAt: item.sentAt,
          sendAt: item.sendAt,
          ...(item.counts ? { recipients: item.counts.recipients, delivered: item.counts.delivered, read: item.counts.read } : {}),
        })),
        morePages: page * PAGE_SIZE < body.total,
      },
      tableCard({
        title: input.mine ? 'Messages you wrote' : 'Messages',
        columns: [
          { key: 'title', label: 'Message' },
          { key: 'audience', label: 'To' },
          { key: 'status', label: 'Status' },
          { key: 'sent', label: 'Sent' },
          { key: 'read', label: 'Read', align: 'end' },
        ],
        rows: body.items.map((item) => ({
          cells: {
            title: text(item.title || 'Untitled'),
            audience: text(item.audience.label),
            status: tag(humanise(item.status)),
            sent: datetime(item.sentAt ?? item.sendAt),
            read: item.counts ? text(`${item.counts.read} of ${item.counts.recipients}`) : num(undefined),
          },
          href: `/messages/${seg(item.id)}`,
        })),
        total: body.total,
      }),
      source('Sent messages', appPath('/messages', { tab: 'sent', mine: input.mine ? 'true' : undefined, status: input.status, kind: input.kind })),
    )
  },
})

export const message = readTool({
  name: 'message',
  description: 'One message in full: its words, who sent it, to whom, when, and for its sender how many it reached and how many read it.',
  permission: 'communication.read',
  input: z.object({ messageId: IdInput('The message id, from my_inbox or list_messages.') }),
  async run(input, context) {
    const found = await fetchParsed(context, MessageDetail, `/messages/${seg(input.messageId)}`)
    if (!found.ok) return found.outcome
    const item = found.body
    const href = `/messages/${seg(item.id)}`
    const title = item.title || 'Untitled message'
    return ok(
      {
        messageId: item.id,
        kind: item.kind,
        title: item.title,
        body: item.body,
        status: item.status,
        audience: item.audience.label,
        from: item.sender.name,
        sentAt: item.sentAt,
        sendAt: item.sendAt,
        withdrawnAt: item.withdrawnAt,
        attachments: item.attachments.map((file) => file.fileName),
        ...(item.counts ? { counts: item.counts } : {}),
        ...(item.myReceipt ? { readByMe: item.myReceipt.readAt !== undefined } : {}),
      },
      recordCard({
        entity: 'other',
        title,
        subtitle: `${MESSAGE_KIND_LABELS[item.kind]} to ${item.audience.label}`,
        tags: [humanise(item.status)],
        facts: [
          fact('From', text(item.sender.name)),
          fact('Sent', datetime(item.sentAt)),
          item.status === 'scheduled' ? fact('Goes out', datetime(item.sendAt)) : undefined,
          fact('Withdrawn', datetime(item.withdrawnAt)),
          fact('Message', text(clip(item.body, 2000))),
          item.attachments.length > 0 ? fact('Attachments', text(item.attachments.map((file) => file.fileName).join(', '))) : undefined,
          item.counts ? fact('Recipients', num(item.counts.recipients)) : undefined,
          item.counts ? fact('Delivered', num(item.counts.delivered)) : undefined,
          item.counts ? fact('Read', num(item.counts.read)) : undefined,
          item.counts ? fact('No consent', num(item.counts.noConsent)) : undefined,
        ],
        href,
      }),
      source(`Message, ${title}`, href),
    )
  },
})

export const MESSAGE_TOOLS = toolList(myInbox, listMessages, message)
