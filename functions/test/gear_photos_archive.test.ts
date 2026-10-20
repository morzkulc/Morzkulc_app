/**
 * Archiwizacja zdjęć złomowanej sztuki (zdjęcia w Storage są pod NUMEREM, więc nowa
 * sztuka o tym samym numerze dziedziczyła zdjęcia starej) + planScrap w syncu sprzętu.
 */
import {describe, it, expect} from "vitest";
import {archiveGearPhotos, kayakStorageNumber, photoTargets, BucketLike, BucketFile} from "../src/modules/equipment/shared/gear_photos_archive";
import {planScrap, isDemoGearDoc, ExistingGearDoc} from "../src/service/tasks/gearSyncAllFromSheet";

function fakeBucket(paths: string[]) {
  const files = new Set(paths);
  const mk = (name: string): BucketFile => ({
    name,
    move: async (dest: string) => {
      files.delete(name);
      files.add(dest);
    },
    exists: async () => [files.has(name)],
  });
  const bucket: BucketLike = {
    getFiles: async ({prefix}) => [[...files].filter((p) => p.startsWith(prefix)).map(mk)],
    file: (p) => mk(p),
  };
  return {bucket, files};
}

describe("photoTargets", () => {
  it("kajak: numer dopełniany do 3 cyfr jak we froncie", () => {
    expect(kayakStorageNumber("7")).toBe("007");
    expect(kayakStorageNumber("13")).toBe("013");
    expect(kayakStorageNumber("120")).toBe("120");
    expect(kayakStorageNumber("P1")).toBe("P1");
    expect(photoTargets("kayaks", "20")).toEqual({kind: "prefix", prefix: "GEAR/KAJAKS/020/"});
  });

  it("kask: dwa dokładne pliki, kamizelka: jeden", () => {
    expect(photoTargets("helmets", "20")).toEqual({kind: "files", paths: ["GEAR/HELMETS/20.webp", "GEAR/HELMETS/20_bok.webp"]});
    expect(photoTargets("lifejackets", "5")).toEqual({kind: "files", paths: ["GEAR/LIFEJACKETS/5.webp"]});
  });

  it("kategoria bez zdjęć albo brak numeru → null", () => {
    expect(photoTargets("paddles", "3")).toBeNull();
    expect(photoTargets("kayaks", "")).toBeNull();
  });
});

describe("archiveGearPhotos", () => {
  const base = {id: "61", number: "20", dateIso: "2026-10-18"};

  it("kajak: przenosi COVER i GALLERY do archiwum, nie rusza innych numerów", async () => {
    const {bucket, files} = fakeBucket([
      "GEAR/KAJAKS/020/COVER/a_thumb.webp",
      "GEAR/KAJAKS/020/GALLERY/b.webp",
      "GEAR/KAJAKS/021/COVER/c.webp",
    ]);
    const res = await archiveGearPhotos({bucket, categoryKey: "kayaks", ...base, dryRun: false});
    expect(res.moved.map((m) => m.to)).toEqual([
      "GEAR/_archiwum/kayaks/20_61_2026-10-18/COVER/a_thumb.webp",
      "GEAR/_archiwum/kayaks/20_61_2026-10-18/GALLERY/b.webp",
    ]);
    expect([...files].sort()).toEqual([
      "GEAR/KAJAKS/021/COVER/c.webp",
      "GEAR/_archiwum/kayaks/20_61_2026-10-18/COVER/a_thumb.webp",
      "GEAR/_archiwum/kayaks/20_61_2026-10-18/GALLERY/b.webp",
    ]);
  });

  it("kask 20 nie zabiera zdjęć kasku 201; brakujący plik pomijany", async () => {
    const {bucket, files} = fakeBucket(["GEAR/HELMETS/20.webp", "GEAR/HELMETS/201.webp"]);
    const res = await archiveGearPhotos({bucket, categoryKey: "helmets", ...base, dryRun: false});
    expect(res.moved).toEqual([{from: "GEAR/HELMETS/20.webp", to: "GEAR/_archiwum/helmets/20_61_2026-10-18/20.webp"}]);
    expect(files.has("GEAR/HELMETS/201.webp")).toBe(true);
  });

  it("dry-run tylko wylicza; pusty katalog → []", async () => {
    const {bucket, files} = fakeBucket(["GEAR/KAJAKS/020/COVER/a.webp"]);
    const res = await archiveGearPhotos({bucket, categoryKey: "kayaks", ...base, dryRun: true});
    expect(res.moved).toHaveLength(1);
    expect(files.has("GEAR/KAJAKS/020/COVER/a.webp")).toBe(true);
    const empty = await archiveGearPhotos({bucket, categoryKey: "kayaks", ...base, number: "99", dryRun: false});
    expect(empty.moved).toEqual([]);
  });
});

describe("planScrap", () => {
  it("ten sam numer i model co aktywna sztuka -> zdjęcia zostają, zgłoszenie; inny model -> archiwum", () => {
    const existing = new Map<string, ExistingGearDoc>([
      ["30", {number: "30", scrapped: false, brand: "Sweet", model: "Wanderer"}],
      ["5", {number: "20", scrapped: false, brand: "Wave sport", model: "Diesel 70"}],
    ]);
    const active = new Map([
      ["30", {id: "20", brand: "sweet", model: " Wanderer"}],
      ["20", {id: "61", brand: "Pyranha", model: "Burn M"}],
    ]);
    const res = planScrap(existing, new Set(), active);
    expect(res.toScrap).toEqual([
      {id: "30", number: "30", archivePhotos: false, sameModelActiveId: "20"},
      {id: "5", number: "20", archivePhotos: true},
    ]);
  });

  it("złomuje tylko brakujące w arkuszu i jeszcze niezłomowane", () => {
    const existing = new Map<string, ExistingGearDoc>([
      ["1", {number: "20", scrapped: false}], // jest w arkuszu
      ["2", {number: "20", scrapped: false}], // zniknął z arkusza → złomować
      ["3", {number: "7", scrapped: true}], // złomowany wcześniej → nie ruszać
    ]);
    const res = planScrap(existing, new Set(["1"]));
    expect(res.toScrap).toEqual([{id: "2", number: "20", archivePhotos: true}]);
    expect(res.alreadyScrapped).toBe(1);
  });

  it("wpis DEMO (kopia prawdziwej sztuki): złomowany, ale bez archiwizacji zdjęć", () => {
    expect(isDemoGearDoc({brand: "DEMO_Dagger", model: "Infrared"})).toBe(true);
    expect(isDemoGearDoc({brand: "Dagger", model: "Infrared"})).toBe(false);
    const existing = new Map<string, ExistingGearDoc>([["64", {number: "61", scrapped: false, demo: true}]]);
    expect(planScrap(existing, new Set()).toScrap).toEqual([{id: "64", number: "61", archivePhotos: false}]);
  });
});
