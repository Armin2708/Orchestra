import { Nav, Footer } from "@/components/Chrome";
import { Hero } from "@/components/Hero";
import { ScrollStrings } from "@/components/ScrollStrings";
import { Stats, Join, Mail, Memory, Review, Cloud, Remote, Changelog } from "@/components/Sections";
import { FinalCta } from "@/components/FinalCta";

export default function App() {
  return (
    <>
      <div className="relative">
        <ScrollStrings />
        <main className="relative z-10">
        <Nav />
        <Hero />
        <Stats />
        <Join />
        <Mail />
        <Memory />
        <Review />
        <Cloud />
        <Remote />
        <Changelog />
        <FinalCta />
        <Footer />
        </main>
      </div>
    </>
  );
}
