///ts:ref=globals
/// <reference path="../../globals.ts"/> ///ts:ref:generated

import fs = require('fs');
import path = require('path');
import os = require('os');
import ts = require('typescript');

import tsconfig = require('../tsconfig/tsconfig');
import languageServiceHost = require('./languageServiceHost');
import utils = require('./utils');

export class Program {
    public languageServiceHost: languageServiceHost.LanguageServiceHost;
    public languageService: ts.LanguageService;

    constructor(public projectFile: tsconfig.TypeScriptProjectFileDetails) {
        this.languageServiceHost = new languageServiceHost.LanguageServiceHost(projectFile);
        this.languageService = ts.createLanguageService(this.languageServiceHost, ts.createDocumentRegistry());

        // Now using the language service we need to get all the referenced files and add them back to the project
        this.increaseProjectForReferenceAndImports();

        this.init();
    }

    private init() {
        // Since we only create a program per project once. Emit the first time
        this.projectFile.project.files.forEach((filename) => this.emitFile(filename));
    }

    emitFile = (filePath: string): EmitOutput => {
        var services = this.languageService;
        var output = services.getEmitOutput(filePath);
        var success = output.emitOutputStatus === ts.EmitReturnStatus.Succeeded;


        if (success) {
            // console.log('SUCCESS ' + filePath);
        }
        else {
            console.log('FAILURE ' + filePath + ' emit');
            var allDiagnostics = services.getCompilerOptionsDiagnostics()
                .concat(services.getSyntacticDiagnostics(filePath))
                .concat(services.getSemanticDiagnostics(filePath));

            console.log(allDiagnostics);
            allDiagnostics.forEach(diagnostic => {
                if (!diagnostic.file) return; // TODO: happens only for 'lib.d.ts' for now

                var lineChar = diagnostic.file.getLineAndCharacterFromPosition(diagnostic.start);
                console.log(diagnostic.file && diagnostic.file.filename, lineChar.line, lineChar.character, diagnostic.messageText);
            });
        }

        output.outputFiles.forEach(o => {
            fs.writeFileSync(o.name, o.text, "utf8");
        });

        var outputFiles = output.outputFiles.map((o) => o.name);
        if (path.extname(filePath) == '.d.ts') {
            outputFiles.push(filePath);
        }

        return {
            outputFiles: outputFiles,
            success: success,
        }
    }

    formatDocument(filePath: string): string {
        var textChanges = this.languageService.getFormattingEditsForDocument(filePath, defaultFormatCodeOptions());   
        var formatted = this.formatCode(this.languageServiceHost.getScriptContent(filePath), textChanges);
        console.log(textChanges, this.languageServiceHost.getScriptContent(filePath), formatted);
        return formatted;
    }

    formatDocumentRange(filePath: string, start: number, end: number): string {
        var textChanges = this.languageService.getFormattingEditsForRange(filePath, start, end, defaultFormatCodeOptions());
        var formatted = this.formatCode(this.languageServiceHost.getScriptContent(filePath), textChanges);
        console.log(textChanges, formatted);
        return formatted;
    }

    // from https://github.com/Microsoft/TypeScript/issues/1651#issuecomment-69877863
    private formatCode(orig: string, changes: ts.TextChange[]): string {
        var result = orig;
        for (var i = changes.length - 1; i >= 0; i--) {
            var change = changes[i];
            var head = result.slice(0, change.span.start());
            var tail = result.slice(change.span.start() + change.span.length());
            result = head + change.newText + tail;
        }
        return result;
    }

    // TODO: push this to use regex and into tsconfig
    increaseProjectForReferenceAndImports = () => {

        var willNeedMoreAnalysis = (file: string) => {
            if (!this.languageServiceHost.hasScript(file)) {
                this.languageServiceHost.addScript(file, fs.readFileSync(file).toString());
                this.projectFile.project.files.push(file);
                return true;
            } else {
                return false;
            }
        }

        var more = this.getReferencedOrImportedFiles(this.projectFile.project.files)
            .filter(willNeedMoreAnalysis);
        while (more.length) {
            more = this.getReferencedOrImportedFiles(this.projectFile.project.files)
                .filter(willNeedMoreAnalysis);
        }
    }

    getReferencedOrImportedFiles = (files: string[]): string[]=> {
        var referenced: string[][] = [];

        files.forEach(file => {
            var preProcessedFileInfo = ts.preProcessFile(this.languageServiceHost.getScriptContent(file), true),
                dir = path.dirname(file);

            referenced.push(
                preProcessedFileInfo.referencedFiles.map(fileReference => utils.pathResolve(dir, fileReference.filename))
                    .concat(
                    preProcessedFileInfo.importedFiles
                        .filter((fileReference) => utils.pathIsRelative(fileReference.filename))
                        .map(fileReference => utils.pathResolve(dir, fileReference.filename + '.ts'))
                    )
                );
        });

        return utils.selectMany(referenced);
    }
}

var programs: { [projectDir: string]: Program } = {}

function getOrCreateProject(filePath): tsconfig.TypeScriptProjectFileDetails {
    try {
        var project = tsconfig.getProjectSync(filePath);
        return project;
    } catch (ex) {
        return tsconfig.createProjectRootSync(filePath);
    }
}

export function getOrCreateProgram(filePath) {
    var projectFile = getOrCreateProject(filePath);
    if (programs[projectFile.projectFileDirectory]) {
        return programs[projectFile.projectFileDirectory];
    } else {
        return programs[projectFile.projectFileDirectory] = new Program(projectFile);
    }
}

export interface EmitOutput {
    outputFiles: string[];
    success: boolean;
}

export interface TSError {
    filePath: string;
    startPos: languageServiceHost.Position;
    endPos: languageServiceHost.Position;
    message: string;
    preview: string;
}

export function getErrorsForFile(filePath: string): TSError[] {
    var program = getOrCreateProgram(filePath);
    var diagnostics = program.languageService.getSyntacticDiagnostics(filePath);
    if (diagnostics.length === 0) {
        diagnostics = program.languageService.getSemanticDiagnostics(filePath);
    }

    return diagnostics.map(diagnostic => ({
        filePath: diagnostic.file.filename,
        startPos: program.languageServiceHost.getPositionFromIndex(filePath, diagnostic.start),
        endPos: program.languageServiceHost.getPositionFromIndex(filePath, diagnostic.length + diagnostic.start),
        message: diagnostic.messageText,
        preview: program.languageServiceHost.getScriptContent(filePath).substr(diagnostic.start, diagnostic.length),
    }));
}
// Filtered means *only* for this file ... not because of file it references/imports
export function getErrorsForFileFiltered(filePath: string): TSError[] {
    // We have inconsistent Unix slashes. 
    // TODO: Make slashes consistent all around.
    var fileName = path.basename(filePath);
    return getErrorsForFile(filePath).filter((error) => path.basename(error.filePath) == fileName);
}

export function defaultFormatCodeOptions(): ts.FormatCodeOptions {
    return {
        IndentSize: 4,
        TabSize: 4,
        NewLineCharacter: os.EOL,
        ConvertTabsToSpaces: true,
        InsertSpaceAfterCommaDelimiter: true,
        InsertSpaceAfterSemicolonInForStatements: true,
        InsertSpaceBeforeAndAfterBinaryOperators: true,
        InsertSpaceAfterKeywordsInControlFlowStatements: true,
        InsertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
        InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
        PlaceOpenBraceOnNewLineForFunctions: false,
        PlaceOpenBraceOnNewLineForControlBlocks: false,
    };
}