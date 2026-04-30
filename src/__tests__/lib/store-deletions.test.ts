import * as store from "@/lib/store";

describe("removed public store facade methods", () => {
  it("does not export deleted house or newsletter helpers", () => {
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
      "subscribeNewsletter",
      "confirmNewsletter",
      "unsubscribeNewsletter",
    ];

    for (const name of removed) {
      expect((store as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
