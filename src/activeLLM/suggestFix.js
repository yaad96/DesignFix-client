import OpenAI from "openai";

/**
 * Validates whether the returned content is likely a full file or just a partial snippet.
 * Returns an object with validation results.
 */
function validateFullFileContent(modifiedContent, originalContent) {
    const result = {
        isFullFile: true,
        warnings: [],
        confidence: 1.0
    };

    if (!modifiedContent || modifiedContent.trim().length === 0) {
        result.isFullFile = false;
        result.warnings.push("Modified content is empty");
        result.confidence = 0;
        return result;
    }

    const originalLines = originalContent.split('\n');
    const modifiedLines = modifiedContent.split('\n');
    const originalLineCount = originalLines.length;
    const modifiedLineCount = modifiedLines.length;

    // Check 1: Line count ratio - modified should be at least 70% of original
    const lineRatio = modifiedLineCount / originalLineCount;
    if (lineRatio < 0.7) {
        result.isFullFile = false;
        result.warnings.push(`Line count too low: ${modifiedLineCount} vs original ${originalLineCount} (${(lineRatio * 100).toFixed(1)}%)`);
        result.confidence -= 0.3;
    }

    // Check 2: For Java files, check for package declaration
    const originalHasPackage = /^\s*package\s+[\w.]+\s*;/m.test(originalContent);
    const modifiedHasPackage = /^\s*package\s+[\w.]+\s*;/m.test(modifiedContent);
    if (originalHasPackage && !modifiedHasPackage) {
        result.isFullFile = false;
        result.warnings.push("Missing package declaration");
        result.confidence -= 0.25;
    }

    // Check 3: Check for import statements preservation
    const originalImports = (originalContent.match(/^\s*import\s+[\w.*]+\s*;/gm) || []).length;
    const modifiedImports = (modifiedContent.match(/^\s*import\s+[\w.*]+\s*;/gm) || []).length;
    if (originalImports > 0 && modifiedImports < originalImports * 0.5) {
        result.isFullFile = false;
        result.warnings.push(`Missing imports: ${modifiedImports} vs original ${originalImports}`);
        result.confidence -= 0.25;
    }

    // Check 4: Check for class/interface declaration
    const originalHasClass = /^\s*(public\s+)?(abstract\s+)?(class|interface|enum)\s+\w+/m.test(originalContent);
    const modifiedHasClass = /^\s*(public\s+)?(abstract\s+)?(class|interface|enum)\s+\w+/m.test(modifiedContent);
    if (originalHasClass && !modifiedHasClass) {
        result.isFullFile = false;
        result.warnings.push("Missing class/interface declaration");
        result.confidence -= 0.25;
    }

    // Check 5: Character length ratio
    const charRatio = modifiedContent.length / originalContent.length;
    if (charRatio < 0.5) {
        result.isFullFile = false;
        result.warnings.push(`Character count too low: ${modifiedContent.length} vs original ${originalContent.length} (${(charRatio * 100).toFixed(1)}%)`);
        result.confidence -= 0.2;
    }

    result.confidence = Math.max(0, result.confidence);
    result.isFullFile = result.confidence >= 0.7;

    return result;
}

/**
 * Attempts to merge a code snippet into the original file content.
 * Uses context matching to find the right location for the snippet.
 */
function mergeSnippetIntoOriginal(snippet, originalContent, violationSnippet) {
    console.log("Attempting to merge snippet into original file...");

    const originalLines = originalContent.split('\n');
    const snippetLines = snippet.split('\n').filter(line => line.trim().length > 0);

    if (snippetLines.length === 0) {
        console.warn("Snippet is empty, returning original content");
        return originalContent;
    }

    // Strategy 1: Try to find the violation snippet in original and replace the matching region
    if (violationSnippet && violationSnippet.trim().length > 0) {
        const violationLines = violationSnippet.split('\n').filter(line => line.trim().length > 0);

        if (violationLines.length > 0) {
            // Find where the violation starts in the original
            const violationStart = findSnippetLocation(originalLines, violationLines);

            if (violationStart !== -1) {
                console.log(`Found violation at line ${violationStart + 1}`);

                // Find the extent of the violation in original
                const violationEnd = violationStart + violationLines.length;

                // Replace the violation region with the snippet
                const beforeViolation = originalLines.slice(0, violationStart);
                const afterViolation = originalLines.slice(violationEnd);

                const merged = [...beforeViolation, ...snippetLines, ...afterViolation].join('\n');
                console.log("Successfully merged snippet using violation location");
                return merged;
            }
        }
    }

    // Strategy 2: Try to find context lines from the snippet in the original
    // Look for the first few non-empty lines of the snippet in the original
    const contextLines = snippetLines.slice(0, Math.min(3, snippetLines.length));
    const snippetLocation = findSnippetLocation(originalLines, contextLines);

    if (snippetLocation !== -1) {
        console.log(`Found snippet context at line ${snippetLocation + 1}`);

        // Replace from this location with the snippet
        const beforeSnippet = originalLines.slice(0, snippetLocation);
        const afterSnippet = originalLines.slice(snippetLocation + snippetLines.length);

        const merged = [...beforeSnippet, ...snippetLines, ...afterSnippet].join('\n');
        console.log("Successfully merged snippet using context matching");
        return merged;
    }

    // Strategy 3: If snippet contains method signature, find and replace that method
    const methodMatch = snippet.match(/^\s*(public|private|protected)?\s*(static)?\s*[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)/m);
    if (methodMatch) {
        const methodName = methodMatch[3];
        console.log(`Looking for method: ${methodName}`);

        const methodLocation = findMethodInOriginal(originalLines, methodName);
        if (methodLocation.start !== -1) {
            console.log(`Found method ${methodName} at lines ${methodLocation.start + 1}-${methodLocation.end + 1}`);

            const beforeMethod = originalLines.slice(0, methodLocation.start);
            const afterMethod = originalLines.slice(methodLocation.end + 1);

            const merged = [...beforeMethod, ...snippetLines, ...afterMethod].join('\n');
            console.log("Successfully merged snippet by replacing method");
            return merged;
        }
    }

    console.warn("Could not find suitable merge location, returning original with snippet appended as comment");
    // Last resort: return original with a warning comment
    return originalContent + "\n\n// TODO: The following fix could not be automatically merged:\n/*\n" + snippet + "\n*/";
}

/**
 * Finds the starting line index where a snippet appears in the original lines.
 * Uses fuzzy matching to handle whitespace differences.
 */
function findSnippetLocation(originalLines, snippetLines) {
    if (snippetLines.length === 0) return -1;

    const normalize = (line) => line.trim().replace(/\s+/g, ' ');
    const firstSnippetLine = normalize(snippetLines[0]);

    for (let i = 0; i < originalLines.length; i++) {
        if (normalize(originalLines[i]) === firstSnippetLine) {
            // Check if subsequent lines also match
            let allMatch = true;
            for (let j = 1; j < snippetLines.length && (i + j) < originalLines.length; j++) {
                if (normalize(originalLines[i + j]) !== normalize(snippetLines[j])) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Finds a method's start and end lines in the original content.
 */
function findMethodInOriginal(originalLines, methodName) {
    const methodPattern = new RegExp(`^\\s*(public|private|protected)?\\s*(static)?\\s*[\\w<>\\[\\]]+\\s+${methodName}\\s*\\(`);

    for (let i = 0; i < originalLines.length; i++) {
        if (methodPattern.test(originalLines[i])) {
            // Found method start, now find the end by counting braces
            let braceCount = 0;
            let methodStarted = false;

            for (let j = i; j < originalLines.length; j++) {
                const line = originalLines[j];
                for (const char of line) {
                    if (char === '{') {
                        braceCount++;
                        methodStarted = true;
                    } else if (char === '}') {
                        braceCount--;
                    }
                }
                if (methodStarted && braceCount === 0) {
                    return { start: i, end: j };
                }
            }
            // If we couldn't find the end, return just the start
            return { start: i, end: i };
        }
    }
    return { start: -1, end: -1 };
}

/**
 * Ensures the modified content is a full file by validating and merging if needed.
 */
function ensureFullFileContent(modifiedContent, originalContent, violationSnippet) {
    const validation = validateFullFileContent(modifiedContent, originalContent);

    console.log("Content validation result:", {
        isFullFile: validation.isFullFile,
        confidence: validation.confidence,
        warnings: validation.warnings
    });

    if (validation.isFullFile) {
        console.log("Content validated as full file");
        return modifiedContent;
    }

    console.warn("Content appears to be partial, attempting to merge into original file");
    return mergeSnippetIntoOriginal(modifiedContent, originalContent, violationSnippet);
}

export async function suggestFix(
    rule,
    example,
    violation,
    surroundingCode,
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

Here is the surrounding class/method structure around the violation, showing the enclosing context:
<<<SURROUNDING_CONTEXT>>>
${surroundingCode}
<<<END_SURROUNDING_CONTEXT>>>

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
    console.log("=== PROMPT SENT TO chatGPT ===");
    //console.log(promptA);

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
            const rawModifiedContent = parsedJSON["modifiedFileContent"] ?? parsedJSON["code"] ?? "";
            const explanation = parsedJSON["explanation"] ?? "";
            const fileName = parsedJSON["fileName"] ?? violationFilePath ?? "";

            // Validate and ensure full file content
            const modifiedFileContent = ensureFullFileContent(
                rawModifiedContent,
                violationFileContent,
                violation
            );

            console.log("Final Solution from chatGPT received:");
            //console.log(parsedJSON);

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

