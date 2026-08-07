import { EntitySchema } from 'typeorm';

export class HiddenSenderEntry {}

/** Domains (or emails) excluded from the Incoming Messages inbox. */
export const HiddenSenderEntrySchema = new EntitySchema({
  name: 'HiddenSenderEntry',
  tableName: 'hidden_sender_entry',
  target: HiddenSenderEntry,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    /** Lowercased domain (e.g. spam.com) or full email address. */
    value: {
      type: 'varchar',
      length: 255,
      nullable: false,
      unique: true,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
  },
});
