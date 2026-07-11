import * as store from "@/lib/store";

describe("removed public store facade methods", () => {
  it("does not export deleted house helpers", () => {
    // Newsletter helpers (removed in M1) were restored alongside the classic-theme
    // newsletter UI; houses remain plain group membership with no separate helpers.
    const removed = [
      "createHouse",
      "getHouse",
      "getHouseByName",
      "listHouses",
      "getHouseMembership",
      "getHouseMembers",
      "getHouseMemberCount",
      "joinHouse",
      "leaveHouse",
      "recalculateHousePoints",
      "getHouseWithDetails",
    ];

    for (const name of removed) {
      expect((store as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
