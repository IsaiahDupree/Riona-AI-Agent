import { validateComment, extractHashtags, DEFAULT_COMMENT_GUIDELINES } from '../../src/client/Instagram-Core';

describe('Instagram Core Functional Tests', () => {
    describe('validateComment', () => {
        it('should validate a correct comment', async () => {
            const comment = 'Great post! 🔥';
            const isValid = await validateComment(comment);
            expect(isValid).toBe(true);
        });

        it('should reject empty comments', async () => {
            const isValid = await validateComment('');
            expect(isValid).toBe(false);
        });

        it('should reject comments with too many emojis', async () => {
            const comment = '🔥'.repeat(10);
            const isValid = await validateComment(comment);
            expect(isValid).toBe(false);
        });

        it('should reject comments with forbidden phrases', async () => {
            const guidelines = { ...DEFAULT_COMMENT_GUIDELINES, forbiddenPhrases: ['bad word'] };
            const isValid = await validateComment('This contains a bad word', guidelines);
            expect(isValid).toBe(false);
        });
    });

    describe('extractHashtags', () => {
        it('should extract hashtags from caption', () => {
            const caption = 'Check this out! #cool #awesome';
            const hashtags = extractHashtags(caption);
            expect(hashtags).toEqual(['#cool', '#awesome']);
        });

        it('should return empty array if no hashtags', () => {
            const caption = 'Just a normal caption';
            const hashtags = extractHashtags(caption);
            expect(hashtags).toEqual([]);
        });

        it('should handle empty caption', () => {
            const hashtags = extractHashtags('');
            expect(hashtags).toEqual([]);
        });
    });
});
