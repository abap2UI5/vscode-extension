CLASS zcl_fx_list_report DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    CONSTANTS:
      BEGIN OF cs_event,
        search TYPE string VALUE `SEARCH`,
        back   TYPE string VALUE `BACK`,
      END OF cs_event.
    DATA mv_search TYPE string.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_fx_list_report IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    CASE client->get_event( ).
      WHEN cs_event-back.
        client->nav_app_leave( ).
        RETURN.
    ENDCASE.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns` v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page`
            )->a( n = `title` v = `List report`
            )->tag( `SearchField`
                )->a( n = `value` v = client->_bind( mv_search )
                )->a( n = `search` v = client->_event( cs_event-search )
            )->tag( `Button`
                )->a( n = `text` v = `Back`
                )->a( n = `press` v = client->_event( me->cs_event-back )
        )->end( ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
