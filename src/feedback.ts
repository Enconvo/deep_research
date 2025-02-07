import { generateObject } from 'ai';
import { z } from 'zod';

import { gpt4Model } from './ai/providers';
import { systemPrompt } from './prompt';
import { BaseChatMessage, ChatMessageContent, LLMProvider } from '@enconvo/api';

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}) {


  const llm = await LLMProvider.fromEnv();
  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(`Given the following query from the user, ask some follow up questions to clarify the research direction. Return a maximum of ${numQuestions} questions, but feel free to return less if the original query is clear: <query>${query}</query>`);
  const stream = await llm.stream({
    messages: [systemMessage, userMessage],
  })

  return stream;

  // const userFeedback = await generateObject({
  //   model: gpt4Model,
  //   system: systemPrompt(),
  //   prompt: `Given the following query from the user, ask some follow up questions to clarify the research direction. Return a maximum of ${numQuestions} questions, but feel free to return less if the original query is clear: <query>${query}</query>`,
  //   schema: z.object({
  //     questions: z
  //       .array(z.string())
  //       .describe(
  //         `Follow up questions to clarify the research direction, max of ${numQuestions}`,
  //       ),
  //   }),
  // });

  // return userFeedback.object.questions.slice(0, numQuestions);
}
