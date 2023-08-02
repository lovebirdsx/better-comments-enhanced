import * as vscode from 'vscode';
import { Configuration } from './configuration';

interface IInput {
    activeEditor: vscode.TextEditor,
    configuration: Configuration,
    languageCode: string,
    range?: vscode.Range,
    contributions: Contributions,
    tags: CommentTag[],
}

interface IDecoration {
    type: vscode.TextEditorDecorationType,
    range: vscode.Range,
}

interface ICommentFormat {
    blockCommentStart: string;
    blockCommentEnd: string;
    delimiter: string;
}

interface IParserState extends ICommentFormat {
    supportedLanguage: boolean;
    ignoreFirstLine: boolean;
    isPlainText: boolean;
    highlightJSDoc: boolean;
    highlightSingleLineComments: boolean;
    highlightMultilineComments: boolean;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function genCommentFormat(
    singleLine: string | string[] | null,
    start: string | null = null,
    end: string | null = null): ICommentFormat {

    const r: ICommentFormat = {
        blockCommentStart: "",
        blockCommentEnd: "",
        delimiter: "",
    };

    // If no single line comment delimiter is passed, single line comments are not supported
    if (singleLine) {
        if (typeof singleLine === 'string') {
            r.delimiter = escapeRegExp(singleLine).replace(/\//ig, "\\/");
        } else if (singleLine.length > 0) {
            // * if multiple delimiters are passed, the language has more than one single line comment format
            var delimiters = singleLine.map(s => escapeRegExp(s)).join("|");
            r.delimiter = delimiters;
        }
    }

    if (start && end) {
        r.blockCommentStart = escapeRegExp(start);
        r.blockCommentEnd = escapeRegExp(end);
    }

    return r;
}

async function processState(input: IInput): Promise<IParserState> {
    const r: IParserState = {} as IParserState;
    r.supportedLanguage = false;
    r.ignoreFirstLine = false;
    r.isPlainText = false;

    const config = await input.configuration.GetCommentConfiguration(input.languageCode);
    if (config) {
        const blockCommentStart = config.blockComment ? config.blockComment[0] : null;
        const blockCommentEnd = config.blockComment ? config.blockComment[1] : null;

        const commentFormat = genCommentFormat(config.lineComment || blockCommentStart, blockCommentStart, blockCommentEnd);
        Object.assign(r, commentFormat);

        r.supportedLanguage = true;
        r.highlightSingleLineComments = !!blockCommentStart;
        r.highlightMultilineComments = false;
        if (blockCommentStart && blockCommentEnd) {
            r.highlightMultilineComments = input.contributions.multilineComments;
        }
    }

    switch (input.languageCode) {
        case "apex":
        case "javascript":
        case "javascriptreact":
        case "typescript":
        case "typescriptreact":
            r.highlightJSDoc = true;
            break;

        case "elixir":
        case "python":
        case "tcl":
            r.ignoreFirstLine = true;
            break;
        
        case "plaintext":
            r.isPlainText = true;

            // If highlight plaintext is enabled, this is a supported language
            r.supportedLanguage = input.contributions.highlightPlainText;
            break;
    }

    return r;
}
    
function genSingleLineRegex(input: IInput, s: IParserState): string {
    // if the language isn't supported, we don't need to go any further
    if (!s.supportedLanguage) {
        return '';
    }

    const characters: Array<string> = [];
    for (const commentTag of input.tags) {
        characters.push(commentTag.escapedTag);
    }

    let expression: string;
    if (s.isPlainText && input.contributions.highlightPlainText) {
        // start by tying the regex to the first character in a line
        expression = "(^)+([ \\t]*[ \\t]*)";
    } else {
        // start by finding the delimiter (//, --, #, ') with optional spaces or tabs
        expression = "(" + s.delimiter + ")+( |\t)*";
    }

    // Apply all configurable comment start tags
    expression += "(";
    expression += characters.join("|");
    expression += ")+(.*)";

    return expression;
}

function findSingleLineComments(input: IInput, s: IParserState): IDecoration[] {
    // If highlight single line comments is off, single line comments are not supported for this language
    if (!s.highlightSingleLineComments)
        return [];

    const text = input.activeEditor.document.getText(input.range);

    // if it's plain text, we have to do mutliline regex to catch the start of the line with ^
    const regexFlags = (s.isPlainText) ? "igm" : "ig";
    const regEx = new RegExp(genSingleLineRegex(input, s), regexFlags);

    let match: RegExpExecArray | null;
    const decorations: IDecoration[] = [];
    const offset = input.range ? input.activeEditor.document.offsetAt(input.range.start) : 0;
    while (match = regEx.exec(text)) {
        const startPos = input.activeEditor.document.positionAt(offset + match.index);
        const endPos = input.activeEditor.document.positionAt(offset + match.index + match[0].length);

        // Required to ignore the first line of .py files (#61)
        if (s.ignoreFirstLine && startPos.line === 0 && startPos.character === 0) {
            continue;
        }

        // Find which custom delimiter was used in order to add it to the collection
        const matchString = match[3] as string;
        const matchTag = input.tags.find(item => item.tag.toLowerCase() === matchString.toLowerCase());

        if (matchTag) {
            decorations.push( {
                type: matchTag.decoration,
                range: new vscode.Range(startPos, endPos),
            });
        }
    }

    return decorations;
}

function findBlockComments(input: IInput, s: IParserState): IDecoration[] {
    // If highlight multiline is off in package.json or doesn't apply to his language, return
    if (!s.highlightMultilineComments) return [];
    
    const text = input.activeEditor.document.getText(input.range);

    // Build up regex matcher for custom delimiter tags
    const characters: Array<string> = [];
    for (const commentTag of input.tags) {
        characters.push(commentTag.escapedTag);
    }

    // Combine custom delimiters and the rest of the comment block matcher
    let commentMatchString = "(^)+([ \\t]*[ \\t]*)(";
    commentMatchString += characters.join("|");
    commentMatchString += ")([ ]*|[:])+([^*/][^\\r\\n]*)";

    // Use start and end delimiters to find block comments
    let regexString = "(^|[ \\t])(";
    regexString += s.blockCommentStart;
    regexString += "[\\s])+([\\s\\S]*?)(";
    regexString += s.blockCommentEnd;
    regexString += ")";

    const regEx = new RegExp(regexString, "gm");
    const commentRegEx = new RegExp(commentMatchString, "igm");

    // Find the multiline comment block
    let match: any;
    const decorations: IDecoration[] = [];
    const offset = input.range ? input.activeEditor.document.offsetAt(input.range.start) : 0;
    while (match = regEx.exec(text)) {
        const commentBlock = match[0];

        // Find the line
        let line;
        while (line = commentRegEx.exec(commentBlock)) {
            const startPos = input.activeEditor.document.positionAt(offset + match.index + line.index + line[2].length);
            const endPos = input.activeEditor.document.positionAt(offset + match.index + line.index + line[0].length);

            // Find which custom delimiter was used in order to add it to the collection
            const matchString = line[3] as string;
            const matchTag = input.tags.find(item => item.tag.toLowerCase() === matchString.toLowerCase());

            if (matchTag) {
                decorations.push( {
                    type: matchTag.decoration,
                    range: new vscode.Range(startPos, endPos),
                });
            }
        }
    }

    return decorations;
}

function findJSDocComments(input: IInput, s: IParserState): IDecoration[] {
    // If highlight multiline is off in package.json or doesn't apply to his language, return
    if (!s.highlightMultilineComments && !s.highlightJSDoc) return [];

    const text = input.activeEditor.document.getText(input.range);

    // Build up regex matcher for custom delimiter tags
    const characters: Array<string> = [];
    for (const commentTag of input.tags) {
        characters.push(commentTag.escapedTag);
    }

    // Combine custom delimiters and the rest of the comment block matcher
    let commentMatchString = "(^)+([ \\t]*\\*[ \\t]*)("; // Highlight after leading *
    const regEx = /(^|[ \t])(\/\*\*)+([\s\S]*?)(\*\/)/gm; // Find rows of comments matching pattern /** */

    commentMatchString += characters.join("|");
    commentMatchString += ")([ ]*|[:])+([^*/][^\\r\\n]*)";

    const commentRegEx = new RegExp(commentMatchString, "igm");

    // Find the multiline comment block
    let match: any;
    const decorations: IDecoration[] = [];
    const offset = input.range ? input.activeEditor.document.offsetAt(input.range.start) : 0;
    while (match = regEx.exec(text)) {
        const commentBlock = match[0];

        // Find the line
        let line;        
        while (line = commentRegEx.exec(commentBlock)) {
            const startPos = input.activeEditor.document.positionAt(offset + match.index + line.index + line[2].length);
            const endPos = input.activeEditor.document.positionAt(offset + match.index + line.index + line[0].length);

            // Find which custom delimiter was used in order to add it to the collection
            const matchString = line[3] as string;
            const matchTag = input.tags.find(item => item.tag.toLowerCase() === matchString.toLowerCase());

            if (matchTag) {
                decorations.push({
                    type: matchTag.decoration,
                    range: new vscode.Range(startPos, endPos),
                });
            }
        }
    }

    return decorations;
}

function findMarkdownTextComments(input: IInput): IDecoration[] {
    if (input.languageCode !== 'markdown')
        return [];

    if (!input.contributions.highlightMarkdown) {
        return [];
    }
    
    const characters: Array<string> = [];
    for (const commentTag of input.tags) {
        characters.push(commentTag.escapedTag);
    }

    let expression = '^[ \\t]*(\\* |- |\\* \\[ \\] |- \\[ \\])[ \\t]*';
    expression += '(';
    expression += characters.join('|');
    expression += ')+(.*)';

    const text = input.activeEditor.document.getText(input.range);

    let match: RegExpExecArray | null;
    const decorations: IDecoration[] = [];
    const regEx = new RegExp(expression, 'igm');
    while (match = regEx.exec(text)) {
        const startPos = input.activeEditor.document.positionAt(match.index);
        const endPos = input.activeEditor.document.positionAt(match.index + match[0].length);

        // Find which custom delimiter was used in order to add it to the collection
        const matchString = match[2];
        const matchTag = input.tags.find(item => item.tag.toLowerCase() === matchString.toLowerCase());

        if (matchTag) {
            decorations.push( {
                type: matchTag.decoration,
                range: new vscode.Range(startPos, endPos),
            });
        }
    }

    return decorations;
}

async function findMarkdownCodeComments(input: IInput): Promise<IDecoration[]> {
    if (input.languageCode !== 'markdown')
        return [];

    const text = input.activeEditor.document.getText(input.range);

    // Regular expression to match code blocks in Markdown
    const regEx = /```\s*(\w+)\s*([\s\S]*?)```/gm;

    let match: RegExpExecArray | null;
    const decorations: IDecoration[] = [];
    while (match = regEx.exec(text)) {
        const codeBlock = match[2];
        const languageCode = match[1];
        const codeBLockIndex = match[0].indexOf(codeBlock);
        
        const startPos = input.activeEditor.document.positionAt(match.index + codeBLockIndex);
        const endPos = input.activeEditor.document.positionAt(match.index + codeBLockIndex + match[2].length);
        const newInput: IInput = {
            ...input,
            languageCode: languageCode,
            range: new vscode.Range(startPos, endPos)
        };
        const newState = await processState(newInput);

        decorations.splice(decorations.length, 0, ...findSingleLineComments(newInput, newState));
        decorations.splice(decorations.length, 0, ...findBlockComments(newInput, newState));
    }
    return decorations;
}

export class Parser {
    private readonly tags: CommentTag[] = [];

    // Read from the package.json
    private readonly contributions: Contributions = vscode.workspace.getConfiguration('better-comments') as any;

    // The configuration necessary to find supported languages on startup
    private readonly configuration: Configuration;

    public constructor(config: Configuration) {
        this.configuration = config;
        this.setTags();
    }

    /**
     * Sets the highlighting tags up for use by the parser
     */
    private setTags(): void {
        const items = this.contributions.tags;
        for (const item of items) {
            const options: vscode.DecorationRenderOptions = { color: item.color, backgroundColor: item.backgroundColor };

            // ? the textDecoration is initialised to empty so we can concat a preceeding space on it
            options.textDecoration = "";

            if (item.strikethrough) {
                options.textDecoration += "line-through";
            }
            
            if (item.underline) {
                options.textDecoration += " underline";
            }
            
            if (item.bold) {
                options.fontWeight = "bold";
            }

            if (item.italic) {
                options.fontStyle = "italic";
            }

            const escapedSequence = item.tag.replace(/([()[{*+.$^\\|?])/g, '\\$1');
            this.tags.push({
                tag: item.tag,
                escapedTag: escapedSequence.replace(/\//gi, "\\/"), // ! hardcoded to escape slashes
                ranges: [],
                decoration: vscode.window.createTextEditorDecorationType(options)
            });
        }
    }

    private genInput(activeEditor: vscode.TextEditor): IInput {
        return {
            activeEditor: activeEditor,
            tags: this.tags,
            contributions: this.contributions,  
            configuration: this.configuration,
            languageCode: activeEditor.document.languageId,
        };
    }

    public async UpdateDecorations(activeEditor: vscode.TextEditor): Promise<void> {
        const map = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();

        function addDecoration(decorations: IDecoration[]) {
            for (const decoration of decorations) {
                const { type, range } = decoration;
                const ranges = map.get(type);
                if (ranges) {
                    ranges.push(range);
                } else {
                    map.set(type, [range]);
                }
            }
        }

        const intput = this.genInput(activeEditor);
        const state = await processState(intput);
        addDecoration(findSingleLineComments(intput, state));
        addDecoration(findBlockComments(intput, state));
        addDecoration(findJSDocComments(intput, state));
        addDecoration(findMarkdownTextComments(intput));
        addDecoration(await findMarkdownCodeComments(intput));

        for (const tag of this.tags) {
            const ranges = map.get(tag.decoration) || [];
            activeEditor.setDecorations(tag.decoration, []);
            activeEditor.setDecorations(tag.decoration, ranges);
        }
    }
    //#endregion
}
