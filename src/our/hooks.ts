import * as vscode from "vscode";
import { formatDepartmentStatusMarkdown, inspectRegisteredDepartments } from "./department-registry";
import { createEnvPolicyRedactor, loadEnvPolicyStatus } from "./env-policy";
import { formatRegistryValidationMarkdown, validateRegistries } from "./registry-validation";
import { adapterRun } from "./adapter-runner";
import { listApprovals } from "./approval-queue";
import { createDecisionNote, listNotes, resolveMemoryRoot } from "./memory-bridge";
import { prepareModeARelay } from "./mode-a-relay";
import { runPipelineObserve } from "./pipeline-runner";

export function registerOurDepartmentCommands(context: vscode.ExtensionContext, redact?: (value: unknown) => string): void {
    const output = vscode.window.createOutputChannel("Connect AI Departments");
    const policyRedact = redact || createEnvPolicyRedactor(context.extensionUri.fsPath);
    const storageRoot = context.globalStorageUri.fsPath;

    context.subscriptions.push(
        output,
        vscode.commands.registerCommand("connectAiLab.departments.status", async () => {
            const statuses = inspectRegisteredDepartments(context.extensionUri.fsPath);
            const envPolicy = loadEnvPolicyStatus(context.extensionUri.fsPath);
            const markdown = formatDepartmentStatusMarkdown(statuses, envPolicy, policyRedact);
            output.clear();
            output.appendLine(markdown);
            output.show(true);

            const doc = await vscode.workspace.openTextDocument({
                content: markdown,
                language: "markdown",
            });
            await vscode.window.showTextDocument(doc, { preview: true });
            vscode.window.showInformationMessage(`Connect AI 부서 상태 확인 완료: ${statuses.length}개`);
        }),
        vscode.commands.registerCommand("connectAiLab.validateRegistry", async () => {
            const result = validateRegistries(context.extensionUri.fsPath);
            const markdown = formatRegistryValidationMarkdown(result, policyRedact);
            output.clear();
            output.appendLine(markdown);
            output.show(true);

            const doc = await vscode.workspace.openTextDocument({
                content: markdown,
                language: "markdown",
            });
            await vscode.window.showTextDocument(doc, { preview: true });
            const message = result.ok ? "Connect AI 레지스트리 검증 PASS" : `Connect AI 레지스트리 검증 FAIL: ${result.errors.length}개`;
            result.ok ? vscode.window.showInformationMessage(message) : vscode.window.showWarningMessage(message);
        }),
        vscode.commands.registerCommand("connectAiLab.memory.validateRoot", async () => {
            const result = resolveMemoryRoot(context.extensionUri.fsPath);
            const markdown = [
                "# Connect AI Memory Root",
                "",
                `- ok: \`${result.ok}\``,
                `- path: \`${policyRedact(result.memoryRoot)}\``,
                `- exists: \`${result.exists}\``,
                `- outsideRepo: \`${result.outsideRepo}\``,
                `- markdownCount: \`${result.noteCount}\``,
                `- writeMode: \`${result.writeMode}\``,
                "",
                "## Warnings",
                "",
                ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"]),
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
            const message = result.ok ? `메모리 루트 검증 완료: ${result.noteCount}개 노트` : "메모리 루트 검증 실패";
            result.ok ? vscode.window.showInformationMessage(message) : vscode.window.showWarningMessage(message);
        }),
        vscode.commands.registerCommand("connectAiLab.memory.listNotes", async () => {
            const notes = listNotes(context.extensionUri.fsPath, storageRoot);
            const markdown = [
                "# Connect AI Memory Notes",
                "",
                `- count: \`${notes.length}\``,
                "",
                "| Note | Bytes | Updated |",
                "|---|---:|---|",
                ...notes.slice(0, 200).map((note) => `| ${note.relPath.replace(/\|/g, "\\|")} | ${note.bytes} | ${note.updatedAt} |`),
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand("connectAiLab.memory.draftDecision", async () => {
            const title = await vscode.window.showInputBox({
                title: "메모리 결정노트 작성",
                prompt: "결정노트 제목",
                value: "Connect AI 메모리 연결",
            });
            if (!title) return;
            const body = await vscode.window.showInputBox({
                title: "메모리 결정노트 작성",
                prompt: "본문 초안. observe 모드에서는 실제 파일을 만들지 않고 미리보기만 표시합니다.",
                value: "- 결정: vault를 순수 markdown 메모리 저장소로 참조\n- 근거: 사람과 에이전트가 같은 지식 그래프를 본다",
            });
            if (!body) return;
            const result = createDecisionNote(context.extensionUri.fsPath, storageRoot, { title, dept: "connect-ai", status: "proposed" }, body);
            const markdown = [
                "# Connect AI Memory Decision Draft",
                "",
                `- mode: \`${result.mode}\``,
                `- wrote: \`${result.wrote}\``,
                `- path: \`${policyRedact(result.path)}\``,
                `- decision: \`${result.gate.decision}\``,
                `- payloadHash: \`${result.gate.payloadHash}\``,
                "",
                "## Preview",
                "",
                "```markdown",
                result.previewContent,
                "```",
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand("connectAiLab.phase2.youtubePipelineObserve", async () => {
            const result = runPipelineObserve(context.extensionUri.fsPath, storageRoot, "youtube-intelligence");
            const markdown = [
                "# Connect AI Phase 2 Pipeline Observe",
                "",
                `- department: \`${result.department}\``,
                `- runId: \`${result.runId}\``,
                `- ok: \`${result.ok}\``,
                `- artifactDir: \`${policyRedact(result.artifactDir)}\``,
                "",
                "| Stage | Decision | Trust | Message |",
                "|---|---|---|---|",
                ...result.stages.map((stage) => `| ${stage.id} | ${stage.decision} | ${stage.trustMode} | ${stage.message} |`),
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
            vscode.window.showInformationMessage("Connect AI Phase 2 YouTube pipeline observe 완료");
        }),
        vscode.commands.registerCommand("connectAiLab.phase2.adapterDryRun", async () => {
            const departmentId = await vscode.window.showInputBox({
                title: "Connect AI Adapter Dry Run",
                prompt: "department id를 입력하세요. 예: youtube-intelligence",
                value: "youtube-intelligence",
            });
            if (!departmentId) return;
            const result = adapterRun(context.extensionUri.fsPath, storageRoot, departmentId, true);
            const markdown = [
                "# Connect AI Adapter Dry Run",
                "",
                `- department: \`${departmentId}\``,
                `- ok: \`${result.ok}\``,
                `- decision: \`${result.gate.decision}\``,
                `- payloadHash: \`${result.gate.payloadHash}\``,
                `- message: ${result.message}`,
                `- approvalToken: ${result.approvalToken ? `\`${result.approvalToken.slice(0, 6)}...\`` : "n/a"}`,
                "",
                "No department command was executed.",
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand("connectAiLab.phase2.prepareClaudeRelay", async () => {
            const title = await vscode.window.showInputBox({
                title: "Mode A Claude Relay",
                prompt: "Claude에 직접 붙여넣을 릴레이 제목",
                value: "manual-claude-review",
            });
            if (!title) return;
            const prompt = await vscode.window.showInputBox({
                title: "Mode A Claude Relay",
                prompt: "짧은 프롬프트를 입력하세요. 민감정보는 env-policy redaction 대상입니다.",
                value: "다음 산출물을 리뷰하고 개선점을 요약해줘.",
            });
            if (!prompt) return;
            const result = prepareModeARelay(context.extensionUri.fsPath, storageRoot, { title, prompt });
            const markdown = [
                "# Mode A Claude Relay Prepared",
                "",
                `- relayId: \`${result.relayId}\``,
                `- gate: \`${result.gateDecision}\``,
                `- promptPath: \`${policyRedact(result.promptPath)}\``,
                `- resultPath: \`${policyRedact(result.resultPath)}\``,
                "",
                "Claude Desktop GUI 자동조작은 하지 않습니다. 사용자가 직접 prompt.md 내용을 Claude 앱에 붙여넣는 Mode A입니다.",
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument(result.promptPath);
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand("connectAiLab.phase2.approvals.show", async () => {
            const approvals = listApprovals(storageRoot);
            const markdown = [
                "# Connect AI Approval Queue",
                "",
                "Approval tokens are single-use and payload-hash bound. This view is read-only.",
                "",
                "| Created | Used | Decision | Action | Department | Payload Hash |",
                "|---|---:|---|---|---|---|",
                ...approvals.slice(-50).map((item) => [
                    item.createdAt,
                    String(item.used),
                    item.decision.decision,
                    item.request.action,
                    item.request.departmentId || "-",
                    item.payloadHash.slice(0, 12),
                ].map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ").replace(/^/, "| ").replace(/$/, " |")),
            ].join("\n");
            output.clear();
            output.appendLine(markdown);
            output.show(true);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
        })
    );
}
