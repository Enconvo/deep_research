import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';
import { BaseChatMessage, ChatMessageContent, LLMProvider, WebSearchProvider } from '@enconvo/api';
import zodToJsonSchema from 'zod-to-json-schema';
import { toObject } from './utils';

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 2;

// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {

  const llm = await LLMProvider.fromEnv();
  const schema = z.object({
    queries: z
      .array(
        z.object({
          query: z.string().describe('The SERP query'),
          researchGoal: z
            .string()
            .describe(
              'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
            ),
        }),
      )
      .describe(`List of SERP queries, max of ${numQueries}`),
  })
  const schemaJson = zodToJsonSchema(schema)

  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(
    `Given the following prompt from the user, generate a list of SERP queries to research the topic. 
    
    # The output should be in the following format:
    {
      "queries": [
        {
          "query": "search query text",
          "researchGoal": "detailed explanation of research goal and next steps"
        }
      ]
    },
    the json schema is:
    ${JSON.stringify(schemaJson)}


    Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${learnings
      ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
        '\n',
      )}`
      : ''
    }`,
  )

  const stream = await llm.call({
    messages: [systemMessage, userMessage]
  })

  // Get text from stream and remove any code block markers if present
  const object = toObject(stream)

  if (!object) {
    console.log("object", object)
    return []
  }

  return object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result?: WebSearchProvider.WebSearchResult;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(result?.items.map(item => item.content)).map(
    content => trimPrompt(content, 25_000),
  );
  console.log(`Ran ${query}, found ${contents.length} contents`);
  const schema = z.object({
    learnings: z
      .array(z.string())
      .describe(`List of learnings, max of ${numLearnings}`),
    followUpQuestions: z
      .array(z.string())
      .describe(
        `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
      ),
  })
  const schemaJson = zodToJsonSchema(schema)

  const llm = await LLMProvider.fromEnv();
  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(
    `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. 
    
    # The output should be in the following format:
    {
      "learnings": ["learning 1", "learning 2", "learning 3"],
      "followUpQuestions": ["question 1", "question 2", "question 3"]
    },
    the json schema is:
    ${JSON.stringify(schemaJson)}

    Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and infromation dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
      .map(content => `<content>\n${content}\n</content>`)
      .join('\n')}</contents>`,
  )

  const stream = await llm.call({
    messages: [systemMessage, userMessage]
  })

  const object = toObject(stream)

  if (!object) {
    console.log("object", object)
    return {
      learnings: [],
      followUpQuestions: [],
    }
  }

  return object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );
  const llm = await LLMProvider.fromEnv();
  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(
    `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
  );
  const stream = await llm.stream({
    messages: [systemMessage, userMessage]
  })


  // Append the visited URLs section to the report
  const urlsSection = `\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  // @ts-ignore
  stream.content.push(ChatMessageContent.text(urlsSection));
  return stream;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
}): Promise<ResearchResult> {

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });

  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map((serpQuery: any) =>
      limit(async () => {
        try {
          console.log(`Searching for ${serpQuery.query}`)


          const webSearchProvider = await WebSearchProvider.fromEnv();

          const result = await webSearchProvider.call({
            query: serpQuery.query
          });
          console.log(`Found ${result?.items.length} results`)

          // Collect URLs from this search
          const newUrls = compact(result?.items.map(item => item.url) ?? []);
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result: result ?? undefined,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            console.log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map((q: string) => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
            });
          } else {
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e) {
          console.error(`Error running query: ${serpQuery.query}: `, e);
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
