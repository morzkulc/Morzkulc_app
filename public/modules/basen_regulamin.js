// Regulamin basenu — treść 1:1 z DOCS/Sessions & TO DOs/01.11_regulamin_basenu.md.
// Zmiana regulaminu = zmiana w obu miejscach.

export function renderRegulaminHtml() {
  return `
    <div class="basenRegulamin">
      <h2>Regulamin basenu SKK Morzkulc</h2>

      <h3>§ 1. Zajęcia</h3>
      <ol>
        <li>Klub organizuje zajęcia kajakowe na basenie w sezonie basenowym (od listopada do końca sezonu podanego w aplikacji), zwykle dwa terminy w tygodniu. Miejsce: Relaxcenter, Hotel Mercure Gdynia Centrum, ul. Armii Krajowej 22.</li>
        <li>Termin to dwie godziny basenowe (I i II), czasem także sauna. Liczba wolnych miejsc jest widoczna w aplikacji.</li>
        <li>Zapisy, saldo godzin basenowych, zakupy i informacje o terminach są wyłącznie w aplikacji klubowej.</li>
        <li>Nad zajęciami czuwają opiekunowie basenu wyznaczeni przez Zarząd. Regulamin pływalni jest nadrzędny; uczestnicy stosują się do poleceń opiekunów.</li>
      </ol>

      <h3>§ 2. Cennik i płatności</h3>
      <div class="basenRegulaminTableWrap">
        <table class="basenRegulaminTable">
          <thead><tr><th>Produkt</th><th>Cena</th><th>Za godzinę</th><th>Godzinki</th><th>Dla kogo</th></tr></thead>
          <tbody>
            <tr><td>Godzina basenowa (pojedyncza)</td><td>35 zł</td><td>35 zł</td><td>—</td><td>każdy z kontem w aplikacji</td></tr>
            <tr><td>Karnet 5</td><td>140 zł</td><td>28 zł</td><td>3</td><td>członek, kandydat — § 3</td></tr>
            <tr><td>Karnet 10</td><td>245 zł</td><td>24,50 zł</td><td>5</td><td>członek, kandydat — § 3</td></tr>
          </tbody>
        </table>
      </div>
      <ol>
        <li>Godzina basenowa = jedna osoba na jednej godzinie basenu albo na saunie.</li>
        <li>Zakup: „Kup” w zakładce <em>Moje konto</em> → przelew na konto Klubu z tytułem podanym w aplikacji. Godziny trafiają na saldo po potwierdzeniu wpłaty przez opiekuna basenu.</li>
        <li>Za pomoc przy organizacji zajęć opiekun basenu może dopisać ekstra godziny basenowe.</li>
        <li>Niewykorzystane godziny pojedyncze zwracane są na wniosek po zakończeniu sezonu.</li>
      </ol>

      <h3>§ 3. Karnety — dofinansowanie Klubu</h3>
      <p>Karnet jest dofinansowaniem Klubu i podlega <em>Zasadom przyznawania dofinansowania</em>.</p>
      <ol>
        <li>Karnet może kupić członek stowarzyszenia lub kandydat, który ma opłacone składki, nie ma zaległości finansowych wobec Klubu i ma dodatnie saldo godzinek wypracowanych. Godzinki wykupione nie dają plusa; saldo musi wynosić co najmniej tyle, ile kosztuje karnet w godzinkach.</li>
        <li>Godzinki za karnet (karnet 5 — 3, karnet 10 — 5) zdejmowane są przy potwierdzeniu wpłaty.</li>
        <li>Karnet jest imienny; jego godzin nie można przekazać innej osobie.</li>
        <li>Karnet jest ważny do końca sezonu podanego w aplikacji. Niewykorzystany karnet rozlicza się wtedy po cenie pojedynczej: zwrot = zapłacona kwota − wykorzystane godziny × 35 zł.</li>
        <li>Przy niekorzystnej sytuacji finansowej Klubu Zarząd może wstrzymać sprzedaż karnetów albo zmienić ich cenę.</li>
      </ol>

      <h3>§ 4. Zapisy i rezygnacja</h3>
      <ol>
        <li>Zapisać można tylko siebie. Zapis pobiera z salda 1 godzinę basenową; bez salda zapis nie jest możliwy.</li>
        <li>Przy zapisie trzeba wybrać kajak: klubowy, prywatny udostępniony (właściciela uprzedzasz sam) albo własny. Wybrany kajak jest na tę godzinę tylko Twój.</li>
        <li>Limity: najwyżej 2 godziny dziennie (godzina I, II i sauna, także jako instruktor) i najwyżej 4 terminy naprzód (z listą rezerwową).</li>
        <li>Rezygnacja najpóźniej 30 h przed terminem (dla terminu o 21:00 — do 15:00 dnia poprzedniego): godzina wraca na saldo.</li>
        <li>Późniejsza rezygnacja albo nieobecność: godzina przepada. Wraca tylko wtedy, gdy miejsce zajmie osoba z listy rezerwowej.</li>
        <li>Lista rezerwowa: gdy brak miejsc, można się na nią zapisać. Zwolnione miejsce automatycznie dostaje pierwsza osoba z listy, która ma godziny na saldzie — dostaje maila.</li>
        <li>Dziecko do 16 lat może pływać bezpłatnie pod opieką osoby dorosłej zapisanej na tę samą godzinę. Opiekun dziecka pełni rolę jego instruktora i ponosi za nie pełną odpowiedzialność. Udział dziecka trzeba wcześniej uzgodnić z opiekunem basenu (miejsce i kajak).</li>
      </ol>

      <h3>§ 5. Czy termin się odbędzie</h3>
      <ol>
        <li>O terminie decyduje się 30 h przed jego rozpoczęciem (w praktyce o 15:00 dnia poprzedniego), na podstawie zapisów w aplikacji.</li>
        <li>Decydują koszty: termin odbywa się, gdy wpływy z zapisów pokrywają koszt wynajmu basenu albo gdy niedobór jest niewielki i mieści się w sezonowym budżecie dopłat Klubu. W przeciwnym razie termin jest odwoływany. Kwoty ustala Zarząd.</li>
        <li>Odwołanie terminu przez Klub zwraca godziny wszystkim zapisanym (także tym, którzy zrezygnowali po terminie) i jest ogłaszane mailem.</li>
        <li>Termin z pulą miejsc dla kursantów odbywa się zawsze.</li>
      </ol>

      <h3>§ 6. Instruktorzy</h3>
      <ol>
        <li>Przy zapisie można wybrać instruktora spośród zapisanych na tę godzinę albo zaznaczyć „dopasujemy później”.</li>
        <li>Instruktor jest zasobem klubowym: korzystanie z niego kosztuje 1 godzinkę za godzinę basenową. Tak jak przy wypożyczaniu sprzętu, saldo może przy tym zejść poniżej zera (do limitu debetu). Godzinka rozliczana jest jak godzina basenowa: wraca przy rezygnacji na czas, odwołaniu terminu przez Klub i wypisaniu się instruktora; przy późniejszej rezygnacji przepada. Sympatyk (bez godzinek) płaci za instruktora dodatkową godziną basenową z salda. Kursant korzysta z instruktora bezpłatnie.</li>
        <li>Instruktor zapisuje się w aplikacji, nie zajmuje miejsca uczestnika i za każdą godzinę odbytego terminu dostaje 1 godzinę basenową.</li>
        <li>Instruktorem basenowym może zostać osoba, która spełnia jeden z warunków:
          <ul>
            <li>odbyła szkolenie na Salzie Szkoleniowej lub Czechach w Tropikach;</li>
            <li>Zarząd uznał jej doświadczenie i umiejętności;</li>
            <li>odbyła szkolenie prowadzone przez instruktorów basenowych i opanowała co najmniej dwie z umiejętności: rolka na obie strony, rolka na rękach, stern squirt lub double-double pump.</li>
          </ul>
        </li>
        <li>Status instruktora nadaje Zarząd.</li>
      </ol>

      <h3>§ 7. Zasady na basenie</h3>
      <ol>
        <li>Zbiórka 20 minut przed I godziną. Wszyscy pomagają znosić i wynosić sprzęt.</li>
        <li>Do kajaka wsiada się z wody albo z brzegu do zwodowanego kajaka. Zakaz wskakiwania z kajakiem do basenu.</li>
        <li>Sprzęt przenosimy ostrożnie, wodę wylewamy poza basenem lub na brodziku. Szkody zgłaszamy opiekunowi (sprzęt — także w aplikacji).</li>
        <li>Własny kajak, wiosło i fartuch trzeba zdezynfekować środkami dostępnymi na pływalni.</li>
        <li>Zostawiamy porządek na basenie, w szatniach i w miejscu przechowywania kajaków.</li>
        <li>Opiekun może usunąć z zajęć osobę, która nie przestrzega regulaminu; przy uporczywym naruszaniu Zarząd może zakazać dalszego udziału.</li>
        <li>Osoby spoza Klubu odpowiadają za wyrządzone szkody indywidualnie.</li>
      </ol>

      <h3>§ 8. Postanowienia końcowe</h3>
      <ol>
        <li>Ceny, zasady karnetów i parametry zapisów ustala Zarząd przed sezonem; aktualne wartości są w aplikacji.</li>
        <li>W sprawach nieuregulowanych decyduje Zarząd; stosuje się Statut SKK Morzkulc.</li>
      </ol>
    </div>
  `;
}
