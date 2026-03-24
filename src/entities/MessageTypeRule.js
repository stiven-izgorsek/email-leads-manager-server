import { EntitySchema } from 'typeorm';

export class MessageTypeRule {}

export const MessageTypeRuleSchema = new EntitySchema({
  name: 'MessageTypeRule',
  tableName: 'message_type_rule',
  target: MessageTypeRule,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    type: {
      type: 'varchar',
      length: 100,
      nullable: false,
    },
    pattern: {
      type: 'text',
      nullable: false,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
    updatedAt: {
      type: 'timestamp',
      updateDate: true,
    },
  },
  uniques: [
    {
      name: 'UQ_message_type_rule_type_pattern',
      columns: ['type', 'pattern'],
    },
  ],
});
