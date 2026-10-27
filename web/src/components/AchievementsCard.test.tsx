import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AchievementsCard } from "./AchievementsCard";
import { config } from "@/test/fixtures";

afterEach(cleanup);

describe("AchievementsCard", () => {
  it("only offers approved chat identities and uses synced names when available", () => {
    const onChange = vi.fn();
    render(<AchievementsCard
      config={{ ...config, approvedSenders: ["group@g.us", "+34600000001", "Old display name"] }}
      chats={[{ id: "group@g.us", name: "Friends" }, { id: "other@g.us", name: "Unapproved" }]}
      onChange={onChange}
    />);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.getByText("Friends")).toBeTruthy();
    expect(screen.queryByText("Unapproved")).toBeNull();
    expect(screen.queryByText("Old display name")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Achievements for group@g.us" }));
    expect(onChange).toHaveBeenCalledWith({ achievementChats: ["group@g.us"] });
  });

  it("disables one chat without changing other enabled chats", () => {
    const onChange = vi.fn();
    render(<AchievementsCard config={{
      ...config, approvedSenders: ["group@g.us", "other@g.us"], achievementChats: ["group@g.us", "other@g.us"],
    }} chats={[]} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Achievements for group@g.us" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ achievementChats: ["other@g.us"] });
  });

  it("explains approval is needed when no approved chats exist", () => {
    render(<AchievementsCard config={config} chats={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Approve a chat above to enable achievements.")).toBeTruthy();
  });
});
