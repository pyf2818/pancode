"use strict";
/* 工具注册表：聚合所有 domain handler，供 agent-llm.js execTool 查表分发。
   每个 handler 签名：async function(agent, args) -> string
   agent 为 LlmAgent 实例，args 为工具参数对象。 */
const fileTools = require("./file-tools");
const processTools = require("./process-tools");
const gitTools = require("./git-tools");
const repoTools = require("./repo-tools");
const memoryTools = require("./memory-tools");
const planTools = require("./plan-tools");
const templateTools = require("./template-tools");
const agentTools = require("./agent-tools");
const webTools = require("./web-tools");
const interactiveTools = require("./interactive-tools");

const TOOL_HANDLERS = Object.assign(
  {},
  fileTools,           // list_files read_file write_file apply_edit delete_file search_code
  processTools,        // run_command start_process stop_process read_process check_port
  gitTools,            // git_status git_diff git_log git_commit git_branch
  repoTools,           // repo_map search_symbol get_diagnostics list_mcp
  memoryTools,         // search_memory save_session_memory create_skill
  planTools,           // create_plan update_plan set_goal goal_status
  templateTools,       // list_templates instantiate_template save_template remove_template
  agentTools,          // agent orchestrate undo
  webTools,            // web_search web_fetch
  interactiveTools,    // ask_user_choice
);

module.exports = { TOOL_HANDLERS };
