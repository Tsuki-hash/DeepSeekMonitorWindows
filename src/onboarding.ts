// 首次使用的任务分流。
//
// 评审 P2：新用户面对一个需要 Key + 网页登录 Token + 本地采集三层配置的应用，
// 容易不知道「现在能做什么」。这里给三张轻量入口卡，按**目标**分流，
// 而不是一个强制读完所有配置的向导。
//
// 只做纯计算：哪些任务已完成、当前该推荐哪个。

export type OnboardingTask = "balance" | "platform" | "local";

export type OnboardingState = {
  apiKeyConfigured: boolean;
  usageTokenConfigured: boolean;
  localEnabled: boolean;
  /** 用户是否已经主动选择过入口（避免反复弹出）。 */
  dismissed: boolean;
};

export type OnboardingTaskInfo = {
  task: OnboardingTask;
  title: string;
  summary: string;
  /** 完成该任务的最小条件。 */
  requirement: string;
  done: boolean;
  /** 是否属于「敏感会话」类，需要在进入前说明。 */
  sensitive: boolean;
};

export function onboardingTasks(state: OnboardingState): OnboardingTaskInfo[] {
  return [
    {
      task: "balance",
      title: "只看余额",
      summary: "验证 API Key 后即可查看账户余额，不需要网页登录。",
      requirement: "配置 API Key",
      done: state.apiKeyConfigured,
      sensitive: false,
    },
    {
      task: "platform",
      title: "平台消费与历史",
      summary:
        "同步网页登录 Token 后查看本月消费、趋势与历史。会话会过期，接口可能变更。",
      requirement: "同步用量 Token",
      done: state.usageTokenConfigured,
      sensitive: true,
    },
    {
      task: "local",
      title: "本地 Agent",
      summary:
        "读取本机六款工具的用量记录，无需 DeepSeek 登录。可能包含估算，不是账户账单。",
      requirement: "开启本地统计",
      done: state.localEnabled,
      sensitive: false,
    },
  ];
}

/**
 * 是否还需要展示入口卡：全部未完成且用户没关过。
 *
 * 只要有一个任务完成就不再遮挡主面板 —— 那时用户已经知道怎么用了。
 */
export function shouldShowOnboarding(state: OnboardingState): boolean {
  if (state.dismissed) return false;
  const tasks = onboardingTasks(state);
  return tasks.every((task) => !task.done);
}

/** 首个推荐任务：余额最轻量，作为默认起点。 */
export function recommendedTask(
  tasks: OnboardingTaskInfo[],
): OnboardingTaskInfo {
  return tasks.find((task) => !task.done) ?? tasks[0];
}
