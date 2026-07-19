import { getMetadataArgsStorage } from 'typeorm';
import { ChatConversationEntity } from './chat-conversation.entity';

describe('ChatConversationEntity purpose column', () => {
  it('declares purpose as varchar(32) default diagnosis', () => {
    const column = getMetadataArgsStorage().columns.find(
      (item) => item.target === ChatConversationEntity && item.propertyName === 'purpose',
    );

    expect(column).toBeDefined();
    expect(column?.options.type).toBe('varchar');
    expect(column?.options.length).toBe(32);
    expect(column?.options.default).toBe('diagnosis');
  });
});
