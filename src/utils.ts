import { BaseChatMessage } from "@enconvo/api";

export const toObject = (stream: BaseChatMessage): any | undefined => {
    let completion: string | undefined = stream.text();
    completion = completion.replace(/```json/g, "")
    completion = completion.replace(/```/g, "")
    completion = completion.match(/{.*}/s)?.[0];

    if (!completion) {
        console.log("completion", completion)
        return undefined
    }

    return JSON.parse(completion)
}
