import OpenAI from "openai";

export async function suggestFix(
    rule,
    example,
    violation,
    exampleFilePath,
    violationFilePath,
    violationFileContent,
    setState,
) {

    const promptA = `You are assisting with enforcing the following design rule:
${rule}

Here is a code example that follows the rule:
${example}
Example file path: ${exampleFilePath}

<<<ORIGINAL_FILE_PATH>>>
${violationFilePath}
<<<END_ORIGINAL_FILE_PATH>>>

<<<ORIGINAL_FILE_CONTENT>>>
${violationFileContent}
<<<END_ORIGINAL_FILE_CONTENT>>>

<<<VIOLATION_SNIPPET>>>
${violation}
<<<END_VIOLATION_SNIPPET>>>

Rewrite the original file so it satisfies the rule while preserving every unrelated line verbatim. Constraints:
- Copy every existing package declaration, import statement, comment, Javadoc, and formatting exactly as provided unless a specific line must change to satisfy the rule.
- Do NOT delete or reorder imports; append new imports after the existing block if required.
- When you modify a line, change only the minimal portion needed; leave all other lines identical.
- Preserve indentation and whitespace on all untouched lines.

Take your time and provide an unstructured response. Include: (1) a detailed explanation of your changes, (2) the fully rewritten file content, and (3) the target file name/path. Do not output JSON in this step.`;

    let attempt = 1;
    let success = false;
    console.log("violation codde is sent to chatGPT:");
    //console.log(violationFileContent);

    while (attempt <= 3 && !success) {
        try {
            // Read the API key from localStorage
            const apiKey = localStorage.getItem("OPENAI_API_KEY");

            // Create a new OpenAI instance with the API key from localStorage
            const openai = new OpenAI({
                apiKey,
                dangerouslyAllowBrowser: true,
            });

            const chatCompletionA = await openai.chat.completions.create({
                model: "gpt-5.2",
                temperature: 0.75,
                messages: [{role: "user", content: promptA}],
            });

            const responseA = chatCompletionA.choices[0].message.content;

            console.log("ReceivedResponseA from chatGPT:");
            //console.log(responseA);

            const promptB = `Here is the input prompt given to you to fix a design rule:
${promptA}

This is the response you generated:
${responseA}

Now, based on these, structure the response to this prompt in a structured JSON format. The JSON should have the following format: {\"explanation\":\"...\", \"code\":\"...\", \"fileName\":\"...\"}. \"code\" must be the fully rewritten file content. Return only JSON.`;

            const chatCompletionB = await openai.chat.completions.create({
                model: "gpt-5.2",
                temperature: 0.2,
                messages: [{role: "user", content: promptB}],
            });

            const suggestedSnippet = chatCompletionB.choices[0].message.content;
            const stripped = suggestedSnippet.replace(/^`json|`json$/g, "").trim();
            const parsedJSON = JSON.parse(stripped);
            const modifiedFileContent = parsedJSON["modifiedFileContent"] ?? parsedJSON["code"] ?? "";
            const explanation = parsedJSON["explanation"] ?? "";
            const fileName = parsedJSON["fileName"] ?? violationFilePath ?? "";

            console.log("Final Solution from chatGPT:");
            console.log(parsedJSON);

            // sets the relevant state in the React component that made the request
            // see ../ui/rulePanel.js for more details
            setState({suggestedSnippet: modifiedFileContent});
            setState({snippetExplanation: explanation});
            setState({suggestionFileName: fileName});

            const llmModifiedFileContent = {
                command: "LLM_MODIFIED_FILE_CONTENT",
                data: {
                    filePath: `${violationFilePath}`,
                    fileToChange: `${fileName}`,
                    modifiedFileContent: modifiedFileContent,
                    explanation: explanation,
                    originalFileContent: violationFileContent,
                },
            };

            // set the modified content state, will be sent plugin
            setState({llmModifiedFileContent: llmModifiedFileContent});

            success = true;
            return llmModifiedFileContent;
        } catch (error) {
            console.log(error);
            success = false;
            attempt++;
        }
    }
}



export async function editFix(fileContentToSendToGPT,conversationHistory,setState) {

    console.log("CAME TO EDIT FIX");
    //console.log(fileContentToSendToGPT);
    //conversationHistory = {role:'user',content:conversationHistory};

    // Create the additional prompt using the projectPath
    const additionalPrompt = `You previously suggested the following fix (JSON snippet below). Integrate it into the provided file without removing unrelated lines.

<<<PREVIOUS_RESPONSE>>>
${conversationHistory}
<<<END_PREVIOUS_RESPONSE>>>

<<<ORIGINAL_FILE_CONTENT>>>
${fileContentToSendToGPT}
<<<END_ORIGINAL_FILE_CONTENT>>>

Rewrite the file so it satisfies the rule while preserving every existing package, import, comment, and formatting exactly as provided unless a line must change to satisfy the rule. Do not delete or reorder imports; only append new ones if required. Modify only the minimal code needed and keep all untouched lines verbatim.
Respond strictly as JSON with the structure {\"modifiedFileContent\":\"...\", \"explanation\":\"...\", \"fileName\":\"...\"}.`;
    const continuedConversation = [ { role: "user", content: additionalPrompt }];

    let attempt = 1;
    let success = false;

    while (attempt <= 3 && !success) {
        try {
            const apiKey = localStorage.getItem("OPENAI_API_KEY");
            const openai = new OpenAI({
                apiKey,
                dangerouslyAllowBrowser: true,
            });

            // Send the continued conversation to OpenAI
            const chatCompletion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                temperature: 0.75,
                messages: continuedConversation,
            });

            const suggestedSnippet = chatCompletion.choices[0].message.content;
            const stripped = suggestedSnippet.replace(/^`json|`json$/g, "").trim();
            const parsedJSON = JSON.parse(stripped);

            console.log(parsedJSON);

            // Update state with new suggested snippet, explanation, and file name
            setState((prevState) => ({
                suggestedSnippet: parsedJSON["modifiedFileContent"],
                snippetExplanation: parsedJSON["explanation"],
                suggestionFileName: parsedJSON["fileName"],
                llmModifiedFileContent: {
                    command: "LLM_MODIFIED_FILE_CONTENT",
                    data: {
                        filePath: `${parsedJSON["fileName"]}`, // Assuming the initial prompt contains the file path
                        fileToChange: `${parsedJSON["fileName"]}`,
                        modifiedFileContent: parsedJSON["modifiedFileContent"],
                        explanation: parsedJSON["explanation"],
                        originalFileContent: prevState?.originalFileContent ?? '',
                    },
                },
            }));

            // Update conversation history in session storage
            //saveConversationToSessionStorage(key, [...continuedConversation, { role: "assistant", content: suggestedSnippet }]);

            success = true;
            console.log("got second data from chatGPT");
        } catch (error) {
            console.log(error);
            success = false;
            attempt++;
        }
    }
}
