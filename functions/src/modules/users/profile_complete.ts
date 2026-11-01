import {normNullish} from "../shared/text_utils";

/**
 * Rejestracja dokończona: formularz profilu wypełniony (imię, nazwisko, telefon, data urodzenia)
 * i obie zgody (RODO, statut). Bez tego aplikacja pokazuje tylko formularz, nie wpisuje osoby do
 * arkusza członków i nie nadaje ID. Wspólna reguła: rejestracja i users.incompleteRegistration.
 */
export function isProfileComplete(p: any): boolean {
  return Boolean(
    normNullish(p?.firstName) &&
    normNullish(p?.lastName) &&
    normNullish(p?.phone) &&
    normNullish(p?.dateOfBirth) &&
    p?.consentRodo === true &&
    p?.consentStatute === true
  );
}
