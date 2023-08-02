import * as path from 'path';
import * as vscode from 'vscode';

import * as json5 from 'json5'
import { TextDecoder } from 'util';

const MARKDOWN_CODE_TO_LANGUAGE_MAP = new Map<string, string>([
    ['bash', 'bash'],
    ['bat', 'bat'],
    ['batch', 'bat'],
    ['c', 'c'],
    ['clj', 'clojure'],
    ['clojure', 'clojure'],
    ['cpp', 'cpp'],
    ['cs', 'csharp'],
    ['csharp', 'csharp'],
    ['css', 'css'],
    ['docker', 'dockerfile'],
    ['dockerfile', 'dockerfile'],
    ['elixir', 'elixir'],
    ['erl', 'erlang'],
    ['erlang', 'erlang'],
    ['ex', 'elixir'],
    ['fs', 'fsharp'],
    ['fsharp', 'fsharp'],
    ['go', 'go'],
    ['gradle.kts', 'groovy'],
    ['gradle.kts', 'groovy'],
    ['gradle', 'groovy'],
    ['groovy', 'groovy'],
    ['haskell', 'haskell'],
    ['hs', 'haskell'],
    ['html', 'html'],
    ['ini', 'ini'],
    ['java', 'java'],
    ['javascript', 'javascript'],
    ['js', 'javascript'],
    ['json', 'json'],
    ['kotlin', 'kotlin'],
    ['kt', 'kotlin'],
    ['less', 'less'],
    ['lua', 'lua'],
    ['pascal', 'pascal'],
    ['perl', 'perl'],
    ['perl6', 'perl6'],
    ['php', 'php'],
    ['powershell', 'powershell'],
    ['properties', 'properties'],
    ['ps', 'powershell'],
    ['py', 'python'],
    ['python', 'python'],
    ['r', 'r'],
    ['raku', 'perl6'],
    ['rb', 'ruby'],
    ['rs', 'rust'],
    ['ruby', 'ruby'],
    ['rust', 'rust'],
    ['sass', 'sass'],
    ['scala', 'scala'],
    ['scss', 'scss'],
    ['sh', 'shell'],
    ['shell', 'shell'],
    ['sql', 'sql'],
    ['swift', 'swift'],
    ['ts', 'typescript'],
    ['typescript', 'typescript'],
    ['vb', 'vb'],
    ['vbnet', 'vb'],
    ['visualbasic', 'vb'],
    ['xml', 'xml'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
]);

export class Configuration {
    private readonly commentConfig = new Map<string, CommentConfig | undefined>();
    private readonly languageConfigFiles = new Map<string, string>();

    /**
     * Creates a new instance of the Parser class
     */
    public constructor() {
        this.UpdateLanguagesDefinitions();
        this.languageConfigFiles.forEach((path, lan) => {
            const markdownLan = MARKDOWN_CODE_TO_LANGUAGE_MAP.get(lan);
            if (markdownLan && lan !== markdownLan) {
                console.warn(`Markdown map incorrect ${lan} -> ${markdownLan}, change to ${lan} -> ${lan}`);
                MARKDOWN_CODE_TO_LANGUAGE_MAP.set(lan, lan);
            }
        });
    }

    /**
     * Generate a map of configuration files by language as defined by extensions
     * External extensions can override default configurations os VSCode
     */
    public UpdateLanguagesDefinitions() {
        this.commentConfig.clear();

        for (let extension of vscode.extensions.all) {
            let packageJSON = extension.packageJSON;

            if (packageJSON.contributes && packageJSON.contributes.languages) {
                for (let language of packageJSON.contributes.languages) {
                    if (language.configuration) {
                        let configPath = path.join(extension.extensionPath, language.configuration);
                        this.languageConfigFiles.set(language.id, configPath);
                    }
                }
            }
        }
    }

    /**
     * Gets the configuration information for the specified language
     * @param languageCode 
     * @returns 
     */
    public async GetCommentConfiguration(languageCode: string): Promise<CommentConfig | undefined> {
        languageCode = MARKDOWN_CODE_TO_LANGUAGE_MAP.get(languageCode) || languageCode;

        // * check if the language config has already been loaded
        if (this.commentConfig.has(languageCode)) {
            return this.commentConfig.get(languageCode);
        }

        // * if no config exists for this language, back out and leave the language unsupported
        if (!this.languageConfigFiles.has(languageCode)) {
            return undefined;
        }

        try {
            // Get the filepath from the map
            const filePath = this.languageConfigFiles.get(languageCode) as string;
            const rawContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            const content = new TextDecoder().decode(rawContent);

            // use json5, because the config can contains comments
            const config = json5.parse(content);

            this.commentConfig.set(languageCode, config.comments);

            return config.comments;
        } catch (error) {
            this.commentConfig.set(languageCode, undefined);
            return undefined;
        }
    }
}
