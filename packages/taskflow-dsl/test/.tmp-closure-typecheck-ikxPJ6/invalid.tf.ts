import { flow, agent } from "taskflow-dsl";
const bad: number = "wrong";
export default flow("invalid", () => agent("ok"));
